import type { AppContext } from '../router.js';
import { ApiError, ok, badRequest, notFound } from '../lib/errors.js';
import { isEventPublished, normalizeEventRow } from '../lib/content-status.js';
import { consumeLatestEmailDispatch } from '../lib/execution.js';
import {
  createEventBooking,
  createEventBookingWithAccess,
  ensureEventPublicBookable,
} from '../services/booking-service.js';
import { getBookingPolicyConfig } from '../domain/booking-effect-policy.js';
import { hashToken } from '../services/token-service.js';

// GET /api/events
export async function handleGetEvents(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'public_events_request_started',
    message: 'Loading public events',
    context: {
      path,
      repository_mode: ctx.env.REPOSITORY_MODE,
      branch_taken: 'load_public_events',
    },
  });
  try {
    const events = (await ctx.providers.repository.getPublishedEvents()).map((event) => normalizeEventRow(event));
    const nowIso = new Date().toISOString();

    const enriched = await Promise.all(events.map(async (event) => {
      const summary = await buildEventState(event.id, nowIso, ctx);
      return { ...event, ...summary };
    }));

    const statusCounts = enriched.reduce<Record<string, number>>((acc, event) => {
      acc[event.status] = (acc[event.status] ?? 0) + 1;
      return acc;
    }, {});
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'public_events_request_completed',
      message: 'Loaded public events',
      context: {
        path,
        repository_mode: ctx.env.REPOSITORY_MODE,
        returned_event_count: enriched.length,
        event_status_counts: statusCounts,
        branch_taken: enriched.length > 0 ? 'return_public_events' : 'return_empty_public_events',
        deny_reason: null,
      },
    });

    return ok({ events: enriched });
  } catch (err) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'public_events_request_failed',
      message: err instanceof Error ? err.message : String(err),
      context: {
        path,
        repository_mode: ctx.env.REPOSITORY_MODE,
        branch_taken: 'propagate_error_to_shared_wrapper',
        deny_reason: err instanceof Error ? err.name : 'unknown_error',
      },
    });
    throw err;
  }
}

// GET /api/events/:slug
export async function handleGetEvent(
  _request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const slug = params['slug'];
  if (!slug) throw notFound();

  const event = await ctx.providers.repository.getEventBySlug(slug);
  if (!event) throw notFound('Event not found');

  const state = await buildEventState(event.id, new Date().toISOString(), ctx);
  return ok({ event: { ...event, ...state } });
}

// POST /api/events/:slug/book
export async function handleEventBook(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const event = await getBookableEventBySlug(params['slug'], ctx);

  const body = await request.json() as Record<string, unknown>;
  const firstName = requireString(body, 'first_name');
  const email = requireString(body, 'email');
  const lastNameRaw = typeof body['last_name'] === 'string' ? body['last_name'].trim() : '';
  const phoneRaw = typeof body['phone'] === 'string' ? body['phone'].trim() : '';
  const couponCode = typeof body['coupon_code'] === 'string' ? body['coupon_code'] : null;

  if (!event.is_paid && !phoneRaw) {
    throw badRequest('phone is required for free events');
  }

  const result = await createEventBooking(
    {
      event,
      firstName,
      lastName: lastNameRaw || null,
      email,
      phone: phoneRaw || null,
      reminderEmailOptIn: Boolean(body['reminder_email_opt_in']),
      reminderWhatsappOptIn: Boolean(body['reminder_whatsapp_opt_in']),
      turnstileToken: (body['turnstile_token'] as string) ?? '',
      remoteIp: request.headers.get('CF-Connecting-IP'),
      couponCode,
    },
    {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      operation: ctx.operation,
    },
  );

  const emailDispatch = consumeLatestEmailDispatch(ctx.operation);
  const mockEmailPreview = emailDispatch?.mockEmailPreview ?? null;
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'event_booking_mock_email_preview_decision',
    message: 'Evaluated inline mock email preview for public event booking',
    context: {
      event_id: event.id,
      event_slug: event.slug,
      booking_id: result.bookingId,
      booking_status: result.status,
      email_mode: ctx.env.EMAIL_MODE,
      ui_test_mode: emailDispatch?.uiTestMode ?? null,
      has_checkout_url: Boolean(result.checkoutUrl),
      has_mock_email_preview: Boolean(mockEmailPreview),
      email_kind: emailDispatch?.emailKind ?? null,
      branch_taken: result.checkoutUrl
        ? 'skip_mock_email_preview_checkout_redirect_flow'
        : emailDispatch?.branchTaken ?? 'skip_mock_email_preview_email_not_dispatched',
      deny_reason: result.checkoutUrl
        ? 'checkout_redirect_flow_has_no_inline_email'
        : emailDispatch?.denyReason ?? 'email_not_dispatched_in_request',
    },
  });

  return ok({
    booking_id: result.bookingId,
    status: result.status,
    ...(result.checkoutUrl ? { checkout_url: result.checkoutUrl } : {}),
    ...(result.checkoutHoldExpiresAt ? { checkout_hold_expires_at: result.checkoutHoldExpiresAt } : {}),
    ...(mockEmailPreview ? { mock_email_preview: mockEmailPreview } : {}),
  });
}

// POST /api/events/:slug/book-with-access
export async function handleEventBookWithAccess(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const event = await getBookableEventBySlug(params['slug'], ctx, { skipPublicCutoffCheck: true });

    const body = await request.json() as Record<string, unknown>;
    const accessToken = requireString(body, 'access_token');
    const firstName = requireString(body, 'first_name');
    const email = requireString(body, 'email');
    const lastNameRaw = typeof body['last_name'] === 'string' ? body['last_name'].trim() : '';
    const phoneRaw = typeof body['phone'] === 'string' ? body['phone'].trim() : '';
    const couponCode = typeof body['coupon_code'] === 'string' ? body['coupon_code'] : null;

    const isPhoneRequired = !event.is_paid;
    const hasPhone = Boolean(phoneRaw);
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'event_booking_with_access_phone_gate_decision',
      message: 'Evaluated late-access phone requirement gate',
      context: {
        event_id: event.id,
        event_slug: event.slug,
        event_is_paid: event.is_paid,
        has_phone: hasPhone,
        phone_required: isPhoneRequired,
        branch_taken: isPhoneRequired
          ? (hasPhone ? 'allow_phone_present' : 'deny_phone_missing')
          : 'skip_phone_requirement_for_paid_event',
        deny_reason: isPhoneRequired && !hasPhone ? 'phone_required_for_free_event' : null,
      },
    });
    if (isPhoneRequired && !hasPhone) {
      throw badRequest('phone is required for free events');
    }

    const tokenHash = await hashToken(accessToken);
    const nowIso = new Date().toISOString();
    const link = await ctx.providers.repository.getEventLateAccessLinkByTokenHash(event.id, tokenHash);
    const linkRevoked = Boolean(link && link.revoked_at !== null);
    const linkExpired = Boolean(link && new Date(link.expires_at).getTime() <= new Date(nowIso).getTime());
    const linkDenyReason = !link
      ? 'late_access_link_not_found'
      : linkRevoked
        ? 'late_access_link_revoked'
        : linkExpired
          ? 'late_access_link_expired'
          : null;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'event_booking_with_access_token_gate_decision',
      message: 'Evaluated late-access token gate',
      context: {
        event_id: event.id,
        event_slug: event.slug,
        has_access_token: Boolean(accessToken),
        late_access_link_found: Boolean(link),
        late_access_link_revoked: linkRevoked,
        late_access_link_expired: linkExpired,
        late_access_link_expires_at: link?.expires_at ?? null,
        branch_taken: linkDenyReason ? 'deny_invalid_or_expired_access_link' : 'allow_valid_access_link',
        deny_reason: linkDenyReason,
      },
    });
    if (linkDenyReason) {
      throw badRequest('Invalid or expired access token');
    }

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'event_booking_with_access_creation_started',
      message: 'Creating booking from validated late-access request',
      context: {
        event_id: event.id,
        event_slug: event.slug,
        event_is_paid: event.is_paid,
        repository_mode: ctx.env.REPOSITORY_MODE,
        email_mode: ctx.env.EMAIL_MODE,
        calendar_mode: ctx.env.CALENDAR_MODE,
        antibot_mode: ctx.env.ANTIBOT_MODE,
        branch_taken: 'create_event_booking_with_access',
      },
    });

    const result = await createEventBookingWithAccess(
      {
        event,
        firstName,
        lastName: lastNameRaw || null,
        email,
        phone: phoneRaw || null,
        reminderEmailOptIn: Boolean(body['reminder_email_opt_in']),
        reminderWhatsappOptIn: Boolean(body['reminder_whatsapp_opt_in']),
        turnstileToken: (body['turnstile_token'] as string) ?? '',
        remoteIp: request.headers.get('CF-Connecting-IP'),
        couponCode,
      },
      {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        operation: ctx.operation,
      },
    );

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'event_booking_with_access_creation_completed',
      message: 'Late-access booking created',
      context: {
        event_id: event.id,
        event_slug: event.slug,
        booking_id: result.bookingId,
        booking_status: result.status,
        branch_taken: 'booking_created_with_late_access',
      },
    });

    const emailDispatch = consumeLatestEmailDispatch(ctx.operation);
    const mockEmailPreview = emailDispatch?.mockEmailPreview ?? null;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'event_booking_with_access_mock_email_preview_decision',
      message: 'Evaluated inline mock email preview for late-access event booking',
      context: {
        event_id: event.id,
        event_slug: event.slug,
        booking_id: result.bookingId,
        booking_status: result.status,
        email_mode: ctx.env.EMAIL_MODE,
        ui_test_mode: emailDispatch?.uiTestMode ?? null,
        has_checkout_url: Boolean(result.checkoutUrl),
        has_mock_email_preview: Boolean(mockEmailPreview),
        email_kind: emailDispatch?.emailKind ?? null,
        branch_taken: result.checkoutUrl
          ? 'skip_mock_email_preview_checkout_redirect_flow'
          : emailDispatch?.branchTaken ?? 'skip_mock_email_preview_email_not_dispatched',
        deny_reason: result.checkoutUrl
          ? 'checkout_redirect_flow_has_no_inline_email'
          : emailDispatch?.denyReason ?? 'email_not_dispatched_in_request',
      },
    });

    return ok({
      booking_id: result.bookingId,
      status: result.status,
      ...(result.checkoutUrl ? { checkout_url: result.checkoutUrl } : {}),
      ...(result.checkoutHoldExpiresAt ? { checkout_hold_expires_at: result.checkoutHoldExpiresAt } : {}),
      ...(mockEmailPreview ? { mock_email_preview: mockEmailPreview } : {}),
    });
  } catch (err) {
    const statusCode = err instanceof ApiError ? err.statusCode : 500;
    if (err instanceof ApiError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'event_booking_with_access_failed',
        message: err.message,
        context: {
          path: new URL(request.url).pathname,
          event_slug: params['slug'] ?? null,
          status_code: statusCode,
          error_code: err.code,
          branch_taken: 'handled_api_error',
          deny_reason: err.message,
        },
      });
    } else {
      ctx.logger.captureException({
        source: 'backend',
        eventType: 'uncaught_exception',
        message: 'Late-access event booking failed',
        error: err,
        context: {
          path: new URL(request.url).pathname,
          event_slug: params['slug'] ?? null,
          status_code: statusCode,
          branch_taken: 'unexpected_exception',
        },
      });
    }
    throw err;
  }
}

// POST /api/events/reminder-subscriptions
export async function handleCreateEventReminderSubscription(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    const body = await request.json() as Record<string, unknown>;
    const email = typeof body['email'] === 'string' ? body['email'].trim() : '';
    const firstName = typeof body['first_name'] === 'string' ? body['first_name'].trim() : '';
    const lastName = typeof body['last_name'] === 'string' ? body['last_name'].trim() : '';
    const eventFamily = typeof body['event_family'] === 'string' && body['event_family'].trim()
      ? body['event_family'].trim()
      : 'illuminate_evenings';

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'event_reminder_subscription_request_started',
      message: 'Evaluating public event reminder subscription request',
      context: {
        path,
        repository_mode: ctx.env.REPOSITORY_MODE,
        has_email: !!email,
        has_first_name: !!firstName,
        has_last_name: !!lastName,
        requested_event_family: eventFamily,
        branch_taken: 'validate_public_reminder_subscription_payload',
      },
    });

    if (!email) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'event_reminder_subscription_validation_failed',
        message: 'Public reminder subscription denied because email was missing',
        context: {
          path,
          repository_mode: ctx.env.REPOSITORY_MODE,
          has_email: false,
          has_first_name: !!firstName,
          has_last_name: !!lastName,
          requested_event_family: eventFamily,
          branch_taken: 'deny_missing_email',
          deny_reason: 'email_required',
        },
      });
      throw badRequest('email is required');
    }

    if (!firstName) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'event_reminder_subscription_validation_failed',
        message: 'Public reminder subscription denied because first name was missing',
        context: {
          path,
          repository_mode: ctx.env.REPOSITORY_MODE,
          has_email: true,
          has_first_name: false,
          has_last_name: !!lastName,
          requested_event_family: eventFamily,
          branch_taken: 'deny_missing_first_name',
          deny_reason: 'first_name_required',
        },
      });
      throw badRequest('first_name is required');
    }

    if (!lastName) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'event_reminder_subscription_validation_failed',
        message: 'Public reminder subscription denied because last name was missing',
        context: {
          path,
          repository_mode: ctx.env.REPOSITORY_MODE,
          has_email: true,
          has_first_name: true,
          has_last_name: false,
          requested_event_family: eventFamily,
          branch_taken: 'deny_missing_last_name',
          deny_reason: 'last_name_required',
        },
      });
      throw badRequest('last_name is required');
    }

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'event_reminder_subscription_validation_completed',
      message: 'Public reminder subscription payload passed validation',
      context: {
        path,
        repository_mode: ctx.env.REPOSITORY_MODE,
        has_email: true,
        has_first_name: true,
        has_last_name: true,
        requested_event_family: eventFamily,
        branch_taken: 'allow_valid_public_reminder_subscription_payload',
        deny_reason: null,
      },
    });

    const created = await ctx.providers.repository.createOrUpdateEventReminderSubscription({
      email,
      first_name: firstName,
      last_name: lastName,
      phone: typeof body['phone'] === 'string' ? body['phone'].trim() || null : null,
      event_family: eventFamily,
    });

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'event_reminder_subscription_request_completed',
      message: 'Public reminder subscription stored successfully',
      context: {
        path,
        repository_mode: ctx.env.REPOSITORY_MODE,
        reminder_subscription_id: created.id,
        normalized_email: created.email,
        event_family: created.event_family,
        branch_taken: 'return_created_reminder_subscription',
        deny_reason: null,
      },
    });

    return ok({ id: created.id, email: created.email, event_family: created.event_family });
  } catch (err) {
    if (err instanceof ApiError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'event_reminder_subscription_request_failed',
        message: err.message,
        context: {
          path,
          repository_mode: ctx.env.REPOSITORY_MODE,
          status_code: err.statusCode,
          error_code: err.code,
          branch_taken: 'handled_api_error',
          deny_reason: err.message,
        },
      });
    } else {
      ctx.logger.captureException?.({
        source: 'backend',
        eventType: 'event_reminder_subscription_request_failed',
        message: 'Public reminder subscription failed unexpectedly',
        error: err,
        context: {
          path,
          repository_mode: ctx.env.REPOSITORY_MODE,
          branch_taken: 'unexpected_exception',
        },
      });
    }
    throw err;
  }
}

async function getBookableEventBySlug(
  slug: string | undefined,
  ctx: AppContext,
  options?: { skipPublicCutoffCheck?: boolean },
) {
  if (!slug) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'event_booking_slug_gate_decision',
      message: 'Event booking denied because slug was missing',
      context: {
        skip_public_cutoff_check: Boolean(options?.skipPublicCutoffCheck),
        branch_taken: 'deny_missing_slug',
        deny_reason: 'event_slug_missing',
      },
    });
    throw notFound('Event not found');
  }
  const event = await ctx.providers.repository.getEventBySlug(slug);
  if (!event) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'event_booking_slug_gate_decision',
      message: 'Event booking denied because event slug was not found',
      context: {
        event_slug: slug,
        skip_public_cutoff_check: Boolean(options?.skipPublicCutoffCheck),
        branch_taken: 'deny_event_not_found',
        deny_reason: 'event_not_found',
      },
    });
    throw notFound('Event not found');
  }

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'event_booking_publish_gate_decision',
    message: 'Evaluated event publish gate for booking',
    context: {
      event_id: event.id,
      event_slug: event.slug,
      event_status: event.status,
      skip_public_cutoff_check: Boolean(options?.skipPublicCutoffCheck),
      normalized_event_status: normalizeEventRow(event).status,
      branch_taken: isEventPublished(event.status) ? 'allow_event_published' : 'deny_event_not_published',
      deny_reason: isEventPublished(event.status) ? null : 'event_not_published',
    },
  });
  if (!isEventPublished(event.status)) throw badRequest('Event is not open for booking');

  if (options?.skipPublicCutoffCheck) {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'event_booking_public_cutoff_gate_decision',
      message: 'Skipped public cutoff gate for event booking',
      context: {
        event_id: event.id,
        event_slug: event.slug,
        skip_public_cutoff_check: true,
        branch_taken: 'skip_public_cutoff_check',
        deny_reason: null,
      },
    });
    return event;
  }

  try {
    await ensureEventPublicBookable(event, ctx.providers.repository);
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'event_booking_public_cutoff_gate_decision',
      message: 'Evaluated public cutoff gate for event booking',
      context: {
        event_id: event.id,
        event_slug: event.slug,
        skip_public_cutoff_check: false,
        branch_taken: 'allow_public_booking_window',
        deny_reason: null,
      },
    });
  } catch (error) {
    const denyReason = error instanceof ApiError ? error.message : 'public_cutoff_gate_check_failed';
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'event_booking_public_cutoff_gate_decision',
      message: 'Event booking denied by public cutoff gate',
      context: {
        event_id: event.id,
        event_slug: event.slug,
        skip_public_cutoff_check: false,
        branch_taken: 'deny_public_booking_window',
        deny_reason: denyReason,
      },
    });
    throw error;
  }

  return event;
}

async function buildEventState(eventId: string, nowIso: string, ctx: AppContext) {
  const event = await ctx.providers.repository.getEventById(eventId);
  if (!event) return {};
  const policy = await getBookingPolicyConfig(ctx.providers.repository);
  const normalizedEvent = normalizeEventRow(event);

  const nowMs = new Date(nowIso).getTime();
  const startMs = new Date(normalizedEvent.starts_at).getTime();
  const cutoffMs = startMs + policy.publicEventCutoffAfterStartMinutes * 60_000;

  const activeBookings = await ctx.providers.repository.countEventActiveBookings(normalizedEvent.id, nowIso);
  const soldOut = normalizedEvent.status === 'sold_out' || activeBookings >= normalizedEvent.capacity;

  const publicRegistrationOpen =
    isEventPublished(normalizedEvent.status) &&
    nowMs <= cutoffMs &&
    !soldOut;

  const isPast = nowMs > cutoffMs;

  return {
    stats: {
      active_bookings: activeBookings,
      capacity: normalizedEvent.capacity,
    },
    render: {
      is_future: !isPast,
      is_past: isPast,
      sold_out: soldOut,
      public_registration_open: publicRegistrationOpen,
      show_reminder_signup_cta: soldOut || isPast,
      late_access_active: false,
    },
  };
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${key} is required`);
  return v.trim();
}
