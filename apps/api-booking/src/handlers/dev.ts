/**
 * Development-only endpoints. Some depend on the in-memory mock repository,
 * while others remain useful with a live database as long as the relevant
 * provider is still mocked.
 */

import type { AppContext } from '../router.js';
import { ok, badRequest, notFound } from '../lib/errors.js';
import { mockState } from '../providers/mock-state.js';
import { buildConfirmUrl, buildManageUrl, cancelBooking, confirmBookingPayment, expireBooking } from '../services/booking-service.js';
import type { Booking } from '../types.js';

function guardMockRepository(ctx: AppContext): void {
  if (ctx.env.REPOSITORY_MODE === 'supabase') {
    throw badRequest('This dev endpoint is only available with the in-memory mock repository');
  }
}

function guardMockPayments(ctx: AppContext): void {
  if (ctx.env.PAYMENTS_MODE !== 'mock') {
    throw badRequest('This dev endpoint is only available when payments are mocked');
  }
}

function guardCapturedEmailPreview(ctx: AppContext): void {
  if (ctx.env.EMAIL_MODE === 'resend') {
    throw badRequest('This dev endpoint is only available when email delivery is captured instead of sent to Resend');
  }
}

function getCapturedEmailOrThrow(emailId: string, ctx: AppContext) {
  const email = mockState.sentEmails.find((entry) => entry.id === emailId);
  if (!email) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'dev_email_preview_request_rejected',
      message: 'Rejected dev email preview request because the captured email was not found',
      context: {
        email_id: emailId,
        email_mode: ctx.env.EMAIL_MODE,
        branch_taken: 'deny_missing_captured_email',
        deny_reason: 'captured_email_not_found',
      },
    });
    throw notFound('Captured email not found');
  }
  return email;
}

function normalizeExampleTestEmail(raw: string | null): string | null {
  const value = raw?.trim().toLowerCase() ?? '';
  return value || null;
}

function normalizeTestEmailPrefix(raw: string | null): string | null {
  const value = raw?.trim().toLowerCase() ?? '';
  return value || null;
}

function normalizeCleanupLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return Math.min(value, 10);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return Math.min(parsed, 10);
      }
    }
  }
  return 10;
}

function isExampleTestEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.toLowerCase().endsWith('@example.test');
}

function isTerminalBookingStatus(status: Booking['current_status']): boolean {
  return status === 'CANCELED' || status === 'EXPIRED' || status === 'COMPLETED' || status === 'NO_SHOW';
}

function toTestBookingSummary(row: Booking) {
  return {
    booking_id: row.id,
    source: row.event_id ? 'event' : 'session',
    status: row.current_status,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    client_id: row.client_id,
    client_first_name: row.client_first_name,
    client_last_name: row.client_last_name,
    client_email: row.client_email,
    event_id: row.event_id,
    event_title: row.event_title,
    session_type_id: row.session_type_id,
    session_type_title: row.session_type_title,
    payment_status: null,
    latest_event_type: null,
  };
}

async function findMatchingTestBookings(emailPrefix: string, ctx: AppContext): Promise<Booking[]> {
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_lookup_started',
    message: 'Started loading test bookings by client tag prefix',
    context: {
      email_prefix: emailPrefix,
      branch_taken: 'load_test_bookings_by_client_tag_prefix',
    },
  });
  const bookings = await ctx.providers.repository.listBookingsByClientTagPrefix(emailPrefix);
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_lookup_completed',
    message: 'Resolved test bookings by client tag prefix',
    context: {
      email_prefix: emailPrefix,
      matched_booking_count: bookings.length,
      branch_taken: 'return_matching_test_bookings',
    },
  });
  return bookings
    .filter((row) => {
      const email = (row.client_email ?? '').toLowerCase();
      const firstName = (row.client_first_name ?? '').trim().toLowerCase();
      return (isExampleTestEmail(email) && email.startsWith(emailPrefix)) || firstName.startsWith(emailPrefix);
    })
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
}

async function getLatestTestBookingByEmail(email: string, ctx: AppContext): Promise<{
  client: { id: string; email: string };
  booking: Booking;
}> {
  const client = await ctx.providers.repository.getClientByEmail(email);
  if (!client) throw notFound('Test client not found');

  const rows = await ctx.providers.repository.getOrganizerBookings({ client_id: client.id });
  const latest = rows
    .slice()
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
  if (!latest) throw notFound('Test booking not found');

  const booking = await ctx.providers.repository.getBookingById(latest.booking_id);
  if (!booking) throw notFound('Test booking not found');

  return {
    client: {
      id: client.id,
      email: client.email,
    },
    booking,
  };
}

// POST /api/__dev/simulate-payment?session_id=<id>&result=success|failure
export async function handleSimulatePayment(request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockPayments(ctx);

    const url = new URL(request.url);
    const sessionId = url.searchParams.get('session_id');
    const result = url.searchParams.get('result');

    if (!sessionId || !result) throw badRequest('session_id and result are required');

    const payment = await ctx.providers.repository.getPaymentByStripeSessionId(sessionId);
    if (!payment) throw badRequest('Payment not found for session_id');
    if (payment.status === 'SUCCEEDED') return ok({ already: 'succeeded' });

    if (result === 'failure') {
      await ctx.providers.repository.updatePayment(payment.id, { status: 'FAILED' });
      return ok({ status: 'failed' });
    }

    if (result !== 'success') throw badRequest('result must be success or failure');

    await confirmBookingPayment(
      {
        id: payment.id,
        booking_id: payment.booking_id,
        provider_payment_id: payment.provider_payment_id,
      },
      {
        paymentIntentId: `mock_pi_${crypto.randomUUID()}`,
        invoiceId: `mock_inv_${crypto.randomUUID()}`,
        invoiceUrl: `${ctx.env.SITE_URL}/mock-invoice/${sessionId}.pdf`,
      },
      {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
      },
    );

    return ok({ status: 'succeeded' });
  } catch (err) {
    throw err;
  }
}

// GET /api/__dev/emails
export async function handleDevEmails(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const requestOrigin = new URL(request.url).origin;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'dev_emails_list_started',
      message: 'Started listing captured emails for the dev preview surface',
      context: {
        email_mode: ctx.env.EMAIL_MODE,
        branch_taken: 'list_captured_emails',
      },
    });
    guardCapturedEmailPreview(ctx);
    const emails = mockState.sentEmails.slice(-50).reverse().map((email) => ({
      id: email.id,
      to: email.to,
      subject: email.subject,
      kind: email.kind,
      sentAt: email.sentAt,
      has_html: Boolean(email.html),
      preview_url: `${ctx.env.SITE_URL}/dev-emails.html?email_id=${encodeURIComponent(email.id)}`,
      preview_html_url: `${requestOrigin}/api/__dev/emails/${encodeURIComponent(email.id)}/html`,
    }));
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'dev_emails_list_completed',
      message: 'Completed listing captured emails for the dev preview surface',
      context: {
        email_mode: ctx.env.EMAIL_MODE,
        email_count: emails.length,
        branch_taken: 'return_captured_emails',
      },
    });
    return ok({ emails });
  } catch (err) {
    throw err;
  }
}

// GET /api/__dev/emails/:emailId
export async function handleDevEmailDetail(request: Request, ctx: AppContext, params: Record<string, string>): Promise<Response> {
  try {
    const requestOrigin = new URL(request.url).origin;
    const emailId = params.emailId ?? '';
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'dev_email_detail_started',
      message: 'Started loading a captured email payload for dev and test inspection',
      context: {
        email_id: emailId,
        email_mode: ctx.env.EMAIL_MODE,
        branch_taken: 'load_captured_email_detail',
      },
    });
    guardCapturedEmailPreview(ctx);
    const email = getCapturedEmailOrThrow(emailId, ctx);
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'dev_email_detail_completed',
      message: 'Completed loading a captured email payload for dev and test inspection',
      context: {
        email_id: emailId,
        email_mode: ctx.env.EMAIL_MODE,
        has_html: Boolean(email.html),
        branch_taken: 'return_captured_email_detail',
      },
    });
    return ok({
      email: {
        id: email.id,
        from: email.from,
        to: email.to,
        subject: email.subject,
        kind: email.kind,
        replyTo: email.replyTo,
        text: email.text,
        html: email.html ?? null,
        sentAt: email.sentAt,
        preview_html_url: `${requestOrigin}/api/__dev/emails/${encodeURIComponent(email.id)}/html`,
      },
    });
  } catch (err) {
    throw err;
  }
}

// GET /api/__dev/emails/:emailId/html
export async function handleDevEmailHtml(_request: Request, ctx: AppContext, params: Record<string, string>): Promise<Response> {
  try {
    const emailId = params.emailId ?? '';
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'dev_email_html_started',
      message: 'Started rendering a captured email payload for browser preview',
      context: {
        email_id: emailId,
        email_mode: ctx.env.EMAIL_MODE,
        branch_taken: 'render_captured_email_html',
      },
    });
    guardCapturedEmailPreview(ctx);
    const email = getCapturedEmailOrThrow(emailId, ctx);
    const body = email.html ?? email.text;
    const contentType = email.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'dev_email_html_completed',
      message: 'Completed rendering a captured email payload for browser preview',
      context: {
        email_id: emailId,
        email_mode: ctx.env.EMAIL_MODE,
        content_type: contentType,
        has_html: Boolean(email.html),
        branch_taken: email.html ? 'return_captured_email_html' : 'return_captured_email_text_fallback',
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': contentType,
      },
    });
  } catch (err) {
    throw err;
  }
}

// GET /api/__dev/failures
export async function handleDevFailures(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockRepository(ctx);
    const failedAttempts = mockState.sideEffectAttempts
      .filter((attempt) => attempt.status === 'FAILED')
      .slice(-50)
      .reverse()
      .map((attempt) => {
        const effect = mockState.sideEffects.find((row) => row.id === attempt.booking_side_effect_id);
        return {
          id: attempt.id,
          booking_side_effect_id: attempt.booking_side_effect_id,
          booking_id: effect?.booking_id ?? null,
          effect_intent: effect?.effect_intent ?? null,
          attempt_num: attempt.attempt_num,
          error_message: attempt.error_message,
          created_at: attempt.created_at,
        };
      });
    return ok({ failed_side_effect_attempts: failedAttempts });
  } catch (err) {
    throw err;
  }
}

// GET /api/__dev/bookings
export async function handleDevBookings(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockRepository(ctx);
    const bookings = [...mockState.bookings.values()].map((booking) => ({
      id: booking.id,
      client_id: booking.client_id,
      source: booking.event_id ? 'event' : 'session',
      status: booking.current_status,
      event_id: booking.event_id,
      session_type_id: booking.session_type_id,
      starts_at: booking.starts_at,
      ends_at: booking.ends_at,
      timezone: booking.timezone,
      google_event_id: booking.google_event_id,
      created_at: booking.created_at,
      updated_at: booking.updated_at,
    }));
    const clients = [...mockState.clients.values()];
    const payments = [...mockState.payments.values()].map((payment) => ({
      id: payment.id,
      booking_id: payment.booking_id,
      provider: payment.provider,
      provider_payment_id: payment.provider_payment_id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      invoice_url: payment.invoice_url,
      paid_at: payment.paid_at,
      created_at: payment.created_at,
      updated_at: payment.updated_at,
    }));
    return ok({ bookings, clients, payments });
  } catch (err) {
    throw err;
  }
}

// GET /api/__test/booking-artifacts?email=<fake@example.test>
export async function handleTestBookingArtifacts(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const url = new URL(request.url);
  const email = normalizeExampleTestEmail(url.searchParams.get('email'));

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_booking_artifacts_request_started',
    message: 'Started test booking-artifacts lookup',
    context: {
      path,
      has_email: Boolean(email),
      branch_taken: 'validate_test_booking_artifacts_request',
    },
  });

  if (!email) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_booking_artifacts_request_rejected',
      message: 'Rejected test booking-artifacts request because email was missing',
      context: {
        path,
        branch_taken: 'deny_missing_email',
        deny_reason: 'email_missing',
      },
    });
    throw badRequest('email is required');
  }

  if (!email.endsWith('@example.test')) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_booking_artifacts_request_rejected',
      message: 'Rejected test booking-artifacts request because email was not a fake test domain',
      context: {
        path,
        email_domain: email.split('@')[1] ?? null,
        branch_taken: 'deny_non_test_email_domain',
        deny_reason: 'email_must_use_example_test_domain',
      },
    });
    throw badRequest('email must use @example.test');
  }

  const resolved = await getLatestTestBookingByEmail(email, ctx).catch((error) => {
    if (error instanceof Error && error.message === 'Test client not found') {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'test_booking_artifacts_request_rejected',
        message: 'Rejected test booking-artifacts request because client was not found',
        context: {
          path,
          email,
          branch_taken: 'deny_client_not_found',
          deny_reason: 'test_client_not_found',
        },
      });
    }
    if (error instanceof Error && error.message === 'Test booking not found') {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'test_booking_artifacts_request_rejected',
        message: 'Rejected test booking-artifacts request because no bookings were found for the client',
        context: {
          path,
          email,
          branch_taken: 'deny_booking_not_found',
          deny_reason: 'test_booking_not_found',
        },
      });
    }
    throw error;
  });

  const client = resolved.client;
  const booking = resolved.booking;
  if (!client) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_booking_artifacts_request_rejected',
      message: 'Rejected test booking-artifacts request because client was not found',
      context: {
        path,
        email,
        branch_taken: 'deny_client_not_found',
        deny_reason: 'test_client_not_found',
      },
    });
    throw notFound('Test client not found');
  }

  const events = await ctx.providers.repository.listBookingEvents(booking.id);
  const latestSubmitted = events
    .filter((event) => event.event_type === 'BOOKING_FORM_SUBMITTED')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  const confirmToken = typeof latestSubmitted?.payload?.['confirm_token'] === 'string'
    ? latestSubmitted.payload['confirm_token'] as string
    : null;
  const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const manageUrl = await buildManageUrl(ctx.env.SITE_URL, booking);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_booking_artifacts_request_completed',
    message: 'Resolved test booking artifacts',
    context: {
      path,
      email,
      client_id: client.id,
      booking_id: booking.id,
      booking_source: booking.event_id ? 'event' : 'session',
      has_confirm_token: Boolean(confirmToken),
      has_payment: Boolean(payment),
      branch_taken: 'return_test_booking_artifacts',
    },
  });

  return ok({
    client: {
      id: client.id,
      email: client.email,
    },
    booking: {
      id: booking.id,
      source: booking.event_id ? 'event' : 'session',
      status: booking.current_status,
      event_id: booking.event_id,
      session_type_id: booking.session_type_id,
      starts_at: booking.starts_at,
      ends_at: booking.ends_at,
      timezone: booking.timezone,
    },
    links: {
      confirm_url: confirmToken ? buildConfirmUrl(ctx.env.SITE_URL, confirmToken) : null,
      manage_url: manageUrl,
    },
    payment: payment ? {
      id: payment.id,
      status: payment.status,
      session_id: payment.provider_payment_id,
      checkout_url: payment.checkout_url,
    } : null,
  });
}

// POST /api/__test/bookings/mutate
export async function handleTestBookingMutate(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const body = await request.json() as Record<string, unknown>;
  const email = normalizeExampleTestEmail(typeof body.email === 'string' ? body.email : null);
  const startsAt = typeof body.starts_at === 'string' ? body.starts_at.trim() : null;
  const endsAt = typeof body.ends_at === 'string' ? body.ends_at.trim() : null;
  const latestSubmissionCreatedAt = typeof body.latest_submission_created_at === 'string'
    ? body.latest_submission_created_at.trim()
    : null;

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_booking_mutate_started',
    message: 'Started test booking mutation request',
    context: {
      path,
      has_email: Boolean(email),
      has_starts_at: Boolean(startsAt),
      has_ends_at: Boolean(endsAt),
      has_latest_submission_created_at: Boolean(latestSubmissionCreatedAt),
      branch_taken: 'validate_test_booking_mutation_request',
    },
  });

  if (!email) throw badRequest('email is required');
  if (!email.endsWith('@example.test')) throw badRequest('email must use @example.test');
  if (!startsAt && !endsAt && !latestSubmissionCreatedAt) {
    throw badRequest('at least one mutation field is required');
  }

  const client = await ctx.providers.repository.getClientByEmail(email);
  if (!client) throw notFound('Test client not found');

  const rows = await ctx.providers.repository.getOrganizerBookings({ client_id: client.id });
  const latest = rows
    .slice()
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
  if (!latest) throw notFound('Test booking not found');

  const booking = await ctx.providers.repository.getBookingById(latest.booking_id);
  if (!booking) throw notFound('Test booking not found');

  let mutatedBooking = booking;
  if (startsAt || endsAt) {
    mutatedBooking = await ctx.providers.repository.updateBooking(booking.id, {
      starts_at: startsAt ?? booking.starts_at,
      ends_at: endsAt ?? booking.ends_at,
    });
  }

  let updatedSubmissionEventId: string | null = null;
  if (latestSubmissionCreatedAt) {
    const events = await ctx.providers.repository.listBookingEvents(booking.id);
    const latestSubmitted = events
      .filter((event) => event.event_type === 'BOOKING_FORM_SUBMITTED')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (!latestSubmitted) throw notFound('Booking submission event not found');
    const updatedEvent = await ctx.providers.repository.updateBookingEventCreatedAt(
      latestSubmitted.id,
      latestSubmissionCreatedAt,
    );
    updatedSubmissionEventId = updatedEvent.id;
  }

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_booking_mutate_completed',
    message: 'Completed test booking mutation request',
    context: {
      path,
      email,
      client_id: client.id,
      booking_id: mutatedBooking.id,
      updated_submission_event_id: updatedSubmissionEventId,
      branch_taken: 'return_test_booking_mutation_result',
    },
  });

  return ok({
    email,
    booking_id: mutatedBooking.id,
    starts_at: mutatedBooking.starts_at,
    ends_at: mutatedBooking.ends_at,
    updated_submission_event_id: updatedSubmissionEventId,
  });
}

// POST /api/__test/bookings/expire
export async function handleTestBookingExpire(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const body = await request.json() as Record<string, unknown>;
  const email = normalizeExampleTestEmail(typeof body.email === 'string' ? body.email : null);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_booking_expire_started',
    message: 'Started test booking expiry request',
    context: {
      path,
      has_email: Boolean(email),
      branch_taken: 'validate_test_booking_expiry_request',
    },
  });

  if (!email) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_booking_expire_rejected',
      message: 'Rejected test booking expiry request because email was missing',
      context: {
        path,
        branch_taken: 'deny_missing_email',
        deny_reason: 'email_missing',
      },
    });
    throw badRequest('email is required');
  }

  if (!email.endsWith('@example.test')) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_booking_expire_rejected',
      message: 'Rejected test booking expiry request because email was not a fake test domain',
      context: {
        path,
        email_domain: email.split('@')[1] ?? null,
        branch_taken: 'deny_non_test_email_domain',
        deny_reason: 'email_must_use_example_test_domain',
      },
    });
    throw badRequest('email must use @example.test');
  }

  const { client, booking } = await getLatestTestBookingByEmail(email, ctx).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Test client not found') {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'test_booking_expire_rejected',
        message: 'Rejected test booking expiry request because client was not found',
        context: {
          path,
          email,
          branch_taken: 'deny_client_not_found',
          deny_reason: 'test_client_not_found',
        },
      });
    } else if (message === 'Test booking not found') {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'test_booking_expire_rejected',
        message: 'Rejected test booking expiry request because no booking was found for the client',
        context: {
          path,
          email,
          branch_taken: 'deny_booking_not_found',
          deny_reason: 'test_booking_not_found',
        },
      });
    }
    throw error;
  });
  const terminalStatuses: Booking['current_status'][] = ['EXPIRED', 'CANCELED', 'COMPLETED', 'NO_SHOW'];
  const denyReason = terminalStatuses.includes(booking.current_status)
    ? 'booking_already_terminal'
    : null;

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_booking_expire_decision',
    message: 'Evaluated test booking expiry eligibility',
    context: {
      path,
      email,
      client_id: client.id,
      booking_id: booking.id,
      booking_status: booking.current_status,
      branch_taken: denyReason ? 'deny_test_booking_expiry' : 'allow_test_booking_expiry',
      deny_reason: denyReason,
    },
  });

  if (denyReason) {
    throw badRequest('Test booking is already terminal');
  }

  const expired = await expireBooking(booking, {
    providers: ctx.providers,
    env: ctx.env,
    logger: ctx.logger,
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    operation: ctx.operation,
  });

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_booking_expire_completed',
    message: 'Completed test booking expiry request',
    context: {
      path,
      email,
      client_id: client.id,
      booking_id: expired.id,
      booking_status: expired.current_status,
      branch_taken: 'return_test_booking_expiry_result',
    },
  });

  return ok({
    email,
    booking_id: expired.id,
    status: expired.current_status,
  });
}

// GET /api/__test/bookings?email_prefix=<prefix>
export async function handleTestBookingsList(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const url = new URL(request.url);
  const emailPrefix = normalizeTestEmailPrefix(url.searchParams.get('email_prefix'));

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_list_request_started',
    message: 'Started test bookings list lookup',
    context: {
      path,
      has_email_prefix: Boolean(emailPrefix),
      branch_taken: 'validate_test_bookings_list_request',
    },
  });

  if (!emailPrefix) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_bookings_list_request_rejected',
      message: 'Rejected test bookings list request because email_prefix was missing',
      context: {
        path,
        branch_taken: 'deny_missing_email_prefix',
        deny_reason: 'email_prefix_missing',
      },
    });
    throw badRequest('email_prefix is required');
  }

  const matches = await findMatchingTestBookings(emailPrefix, ctx);
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_list_request_completed',
    message: 'Resolved test bookings list',
    context: {
      path,
      email_prefix: emailPrefix,
      matched_count: matches.length,
      branch_taken: 'return_test_bookings_list',
    },
  });

  return ok({
    email_prefix: emailPrefix,
    count: matches.length,
    bookings: matches.map(toTestBookingSummary),
  });
}

// POST /api/__test/bookings/cleanup
export async function handleTestBookingsCleanup(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const body = await request.json() as Record<string, unknown>;
  const emailPrefix = normalizeTestEmailPrefix(typeof body.email_prefix === 'string' ? body.email_prefix : null);
  const limit = normalizeCleanupLimit(body.limit);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_cleanup_started',
    message: 'Started test bookings cleanup request',
    context: {
      path,
      has_email_prefix: Boolean(emailPrefix),
      batch_limit: limit,
      branch_taken: 'validate_test_bookings_cleanup_request',
    },
  });

  if (!emailPrefix) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_bookings_cleanup_rejected',
      message: 'Rejected test bookings cleanup request because email_prefix was missing',
      context: {
        path,
        branch_taken: 'deny_missing_email_prefix',
        deny_reason: 'email_prefix_missing',
      },
    });
    throw badRequest('email_prefix is required');
  }

  const matches = await findMatchingTestBookings(emailPrefix, ctx);
  const activeMatches = matches.filter((row) => !isTerminalBookingStatus(row.current_status));
  const terminalMatches = matches.filter((row) => isTerminalBookingStatus(row.current_status));
  const batch = activeMatches.slice(0, limit);
  const canceled: Array<{ booking_id: string; status: string }> = [];
  const skipped: Array<{ booking_id: string; status: string; reason: string }> = [];
  const failed: Array<{ booking_id: string; status: string; reason: string }> = [];

  for (const row of terminalMatches) {
    skipped.push({
      booking_id: row.id,
      status: row.current_status,
      reason: 'already_terminal',
    });
  }

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_cleanup_batch_planned',
    message: 'Planned test bookings cleanup batch',
    context: {
      path,
      email_prefix: emailPrefix,
      matched_count: matches.length,
      active_matched_count: activeMatches.length,
      terminal_matched_count: terminalMatches.length,
      processed_count: batch.length,
      batch_limit: limit,
      branch_taken: 'cleanup_batch_planned',
    },
  });

  for (const row of batch) {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'test_bookings_cleanup_booking_started',
      message: 'Started cleanup for test booking',
      context: {
        path,
        email_prefix: emailPrefix,
        booking_id: row.id,
        booking_status: row.current_status,
        client_id: row.client_id,
        client_email: row.client_email ?? null,
        branch_taken: 'cleanup_single_booking_started',
      },
    });
    try {
      const booking = await ctx.providers.repository.getBookingById(row.id);
      if (!booking) {
        failed.push({
          booking_id: row.id,
          status: row.current_status,
          reason: 'booking_lookup_failed',
        });
        ctx.logger.logWarn?.({
          source: 'backend',
          eventType: 'test_bookings_cleanup_booking_failed',
          message: 'Failed test booking cleanup because booking lookup did not return a row',
          context: {
            path,
            email_prefix: emailPrefix,
            booking_id: row.id,
            booking_status: row.current_status,
            branch_taken: 'cleanup_booking_lookup_failed',
            deny_reason: 'booking_lookup_failed',
          },
        });
        continue;
      }

      const result = await cancelBooking(booking, {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        operation: ctx.operation,
      }, {
        source: 'ADMIN_UI',
        bypassPolicyWindow: true,
      });

      if (!result.ok) {
        failed.push({
          booking_id: row.id,
          status: row.current_status,
          reason: result.code,
        });
        ctx.logger.logWarn?.({
          source: 'backend',
          eventType: 'test_bookings_cleanup_booking_failed',
          message: 'Failed test booking cleanup because cancellation service denied the booking',
          context: {
            path,
            email_prefix: emailPrefix,
            booking_id: row.id,
            booking_status: row.current_status,
            branch_taken: 'cleanup_cancellation_denied',
            deny_reason: result.code,
          },
        });
        continue;
      }

        canceled.push({
          booking_id: row.id,
          status: result.booking.current_status,
        });
      ctx.logger.logInfo?.({
        source: 'backend',
        eventType: 'test_bookings_cleanup_booking_completed',
        message: 'Completed cleanup for test booking',
        context: {
          path,
          email_prefix: emailPrefix,
            booking_id: row.id,
            booking_status: result.booking.current_status,
            branch_taken: 'cleanup_single_booking_canceled',
          },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unexpected_cleanup_failure';
        failed.push({
          booking_id: row.id,
          status: row.current_status,
          reason,
        });
      ctx.logger.captureException?.({
        source: 'backend',
        eventType: 'test_bookings_cleanup_booking_failed',
        message: 'Unexpected test booking cleanup failure',
        error,
        context: {
          path,
          email_prefix: emailPrefix,
            booking_id: row.id,
            booking_status: row.current_status,
            branch_taken: 'cleanup_unexpected_exception',
          },
      });
    }
  }

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_cleanup_completed',
    message: 'Completed test bookings cleanup request',
    context: {
      path,
      email_prefix: emailPrefix,
      matched_count: matches.length,
      active_matched_count: activeMatches.length,
      processed_count: batch.length,
      remaining_active_count: Math.max(activeMatches.length - batch.length, 0),
      batch_limit: limit,
      canceled_count: canceled.length,
      skipped_count: skipped.length,
      failed_count: failed.length,
      branch_taken: failed.length > 0 ? 'cleanup_completed_with_failures' : 'cleanup_completed_successfully',
      deny_reason: failed.length > 0 ? 'one_or_more_bookings_failed_cleanup' : null,
    },
  });

  return ok({
    email_prefix: emailPrefix,
    matched_count: matches.length,
    active_matched_count: activeMatches.length,
    processed_count: batch.length,
    remaining_active_count: Math.max(activeMatches.length - batch.length, 0),
    batch_limit: limit,
    canceled_count: canceled.length,
    skipped_count: skipped.length,
    failed_count: failed.length,
    canceled,
    skipped,
    failed,
  });
}
