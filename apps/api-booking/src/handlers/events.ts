import type { AppContext } from '../router.js';
import { ok, badRequest, notFound, errorResponse } from '../lib/errors.js';
import {
  createEventBooking,
  createEventBookingWithAccess,
  ensureEventPublicBookable,
} from '../services/booking-service.js';
import { hashToken } from '../services/token-service.js';

const PUBLIC_EVENT_CUTOFF_AFTER_START_MINUTES = 30;

// GET /api/events
export async function handleGetEvents(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    const events = await ctx.providers.repository.getPublishedEvents();
    const nowIso = new Date().toISOString();

    const enriched = await Promise.all(events.map(async (event) => {
      const summary = await buildEventState(event.id, nowIso, ctx);
      return { ...event, ...summary };
    }));

    return ok({ events: enriched });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/events/:slug
export async function handleGetEvent(
  _request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const slug = params['slug'];
    if (!slug) throw notFound();

    const event = await ctx.providers.repository.getEventBySlug(slug);
    if (!event) throw notFound('Event not found');

    const state = await buildEventState(event.id, new Date().toISOString(), ctx);
    return ok({ event: { ...event, ...state } });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/events/:slug/book
export async function handleEventBook(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const event = await getBookableEventBySlug(params['slug'], ctx);

    const body = await request.json() as Record<string, unknown>;
    const firstName = requireString(body, 'first_name');
    const email = requireString(body, 'email');
    const lastNameRaw = typeof body['last_name'] === 'string' ? body['last_name'].trim() : '';
    const phoneRaw = typeof body['phone'] === 'string' ? body['phone'].trim() : '';

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
      },
      {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
      },
    );

    return ok({
      booking_id: result.bookingId,
      status: result.status,
      ...(result.checkoutUrl ? { checkout_url: result.checkoutUrl } : {}),
      ...(result.checkoutHoldExpiresAt ? { checkout_hold_expires_at: result.checkoutHoldExpiresAt } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
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

    if (!event.is_paid && !phoneRaw) {
      throw badRequest('phone is required for free events');
    }

    const tokenHash = await hashToken(accessToken);
    const link = await ctx.providers.repository.getEventLateAccessLinkByTokenHash(event.id, tokenHash);
    if (!link || link.revoked_at !== null || new Date(link.expires_at) <= new Date()) {
      throw badRequest('Invalid or expired access token');
    }

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
      },
      {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
      },
    );

    return ok({
      booking_id: result.bookingId,
      status: result.status,
      ...(result.checkoutUrl ? { checkout_url: result.checkoutUrl } : {}),
      ...(result.checkoutHoldExpiresAt ? { checkout_hold_expires_at: result.checkoutHoldExpiresAt } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/events/reminder-subscriptions
export async function handleCreateEventReminderSubscription(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;
    const email = requireString(body, 'email');

    const created = await ctx.providers.repository.createOrUpdateEventReminderSubscription({
      email,
      first_name: typeof body['first_name'] === 'string' ? body['first_name'].trim() || null : null,
      last_name: typeof body['last_name'] === 'string' ? body['last_name'].trim() || null : null,
      phone: typeof body['phone'] === 'string' ? body['phone'].trim() || null : null,
      event_family: typeof body['event_family'] === 'string' && body['event_family'].trim()
        ? body['event_family'].trim()
        : 'illuminate_evenings',
    });

    return ok({ id: created.id, email: created.email, event_family: created.event_family });
  } catch (err) {
    return errorResponse(err);
  }
}

async function getBookableEventBySlug(
  slug: string | undefined,
  ctx: AppContext,
  options?: { skipPublicCutoffCheck?: boolean },
) {
  if (!slug) throw notFound('Event not found');
  const event = await ctx.providers.repository.getEventBySlug(slug);
  if (!event) throw notFound('Event not found');
  if (event.status !== 'published') throw badRequest('Event is not open for booking');

  if (!options?.skipPublicCutoffCheck) {
    await ensureEventPublicBookable(event);
  }

  return event;
}

async function buildEventState(eventId: string, nowIso: string, ctx: AppContext) {
  const event = await ctx.providers.repository.getEventById(eventId);
  if (!event) return {};

  const nowMs = new Date(nowIso).getTime();
  const startMs = new Date(event.starts_at).getTime();
  const cutoffMs = startMs + PUBLIC_EVENT_CUTOFF_AFTER_START_MINUTES * 60_000;

  const activeBookings = await ctx.providers.repository.countEventActiveBookings(event.id, nowIso);
  const soldOut = activeBookings >= event.capacity;
  const lateAccess = await ctx.providers.repository.getActiveEventLateAccessLinkForEvent(event.id, nowIso);

  const publicRegistrationOpen =
    event.status === 'published' &&
    nowMs <= cutoffMs &&
    !soldOut;

  const isPast = nowMs > cutoffMs;

  return {
    stats: {
      active_bookings: activeBookings,
      capacity: event.capacity,
    },
    render: {
      is_future: !isPast,
      is_past: isPast,
      sold_out: soldOut,
      public_registration_open: publicRegistrationOpen,
      show_reminder_signup_cta: soldOut || isPast,
      late_access_active: Boolean(lateAccess),
    },
  };
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${key} is required`);
  return v.trim();
}
