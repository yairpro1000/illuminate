import type { AppContext } from '../router.js';
import type { Env } from '../env.js';
import type { OrganizerBookingFilters } from '../providers/repository/interface.js';
import { created, badRequest, notFound, errorResponse, ok } from '../lib/errors.js';
import { requireAdminAccess } from '../lib/admin-access.js';
import { generateToken, hashToken } from '../services/token-service.js';
import {
  SERVICE_MODES,
  getAllOverrides,
  setOverride,
  clearOverride,
  type ServiceKey,
} from '../lib/config-overrides.js';

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function coerceNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatEventDisplay(startsAt: string, timezone: string): string {
  return new Date(startsAt).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  });
}

function buildLateAccessUrl(event: {
  slug: string;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  address_line: string;
  is_paid: boolean;
  price_per_person_cents: number | null;
}, siteUrl: string, token: string): string {
  const params = new URLSearchParams({
    source: 'evening',
    eventSlug: event.slug,
    eventTitle: event.title,
    eventDate: event.starts_at.slice(0, 10),
    eventDisplay: formatEventDisplay(event.starts_at, event.timezone),
    eventStart: event.starts_at,
    eventEnd: event.ends_at,
    eventLocation: event.address_line,
    isPaid: String(event.is_paid),
    price: String(event.price_per_person_cents ?? 0),
    access: token,
  });
  return `${siteUrl.replace(/\/+$/g, '')}/book.html?${params.toString()}`;
}

function parseBookingFilters(url: URL): OrganizerBookingFilters {
  const source = url.searchParams.get('source');
  const eventId = url.searchParams.get('event_id');
  const date = url.searchParams.get('date');
  const clientId = url.searchParams.get('client_id');
  const status = url.searchParams.get('status');

  return {
    booking_kind: source === 'event' || source === 'session' ? source : undefined,
    event_id: eventId?.trim() || undefined,
    date: date?.trim() || undefined,
    client_id: clientId?.trim() || undefined,
    current_status: status?.trim() as OrganizerBookingFilters['current_status'] | undefined,
  };
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await request.json() as Record<string, unknown>;
  }

  const raw = await request.text();
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

// GET /api/admin/events
export async function handleAdminGetEvents(request: Request, ctx: AppContext): Promise<Response> {
  try {
    ctx.logger.logInfo({
      eventType: 'admin_events_request',
      message: 'Admin events auth starting',
      context: {
        path: new URL(request.url).pathname,
        admin_auth_disabled: /^(1|true|yes|on)$/i.test(String(ctx.env.ADMIN_AUTH_DISABLED ?? '').trim()),
      },
    });
    await requireAdminAccess(request, ctx.env, ctx.logger);
    const events = await ctx.providers.repository.getPublishedEvents();
    return ok({
      events: events.map((event) => ({
        id: event.id,
        slug: event.slug,
        title: event.title,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        status: event.status,
      })),
    });
  } catch (err) {
    ctx.logger.logWarn({
      eventType: 'admin_events_request_failed',
      message: err instanceof Error ? err.message : String(err),
      context: {
        path: new URL(request.url).pathname,
        admin_auth_disabled: /^(1|true|yes|on)$/i.test(String(ctx.env.ADMIN_AUTH_DISABLED ?? '').trim()),
        status_code: (err as { statusCode?: number })?.statusCode ?? 500,
        auth_failure_reason: err instanceof Error ? err.message : String(err),
      },
    });
    return errorResponse(err);
  }
}

// GET /api/admin/bookings
export async function handleAdminGetBookings(request: Request, ctx: AppContext): Promise<Response> {
  try {
    await requireAdminAccess(request, ctx.env);
    const filters = parseBookingFilters(new URL(request.url));
    const rows = await ctx.providers.repository.getOrganizerBookings(filters);
    return ok({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}

// PATCH /api/admin/bookings/:bookingId
export async function handleAdminUpdateBooking(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  try {
    await requireAdminAccess(request, ctx.env);
    const bookingId = params.bookingId?.trim();
    if (!bookingId) throw badRequest('bookingId is required');

    const booking = await ctx.providers.repository.getBookingById(bookingId);
    if (!booking) throw notFound('Booking not found');

    const body = await parseJsonBody(request);
    const clientPatch = typeof body.client === 'object' && body.client !== null
      ? body.client as Record<string, unknown>
      : null;
    const bookingPatch = typeof body.booking === 'object' && body.booking !== null
      ? body.booking as Record<string, unknown>
      : null;

    if (!clientPatch && !bookingPatch) {
      throw badRequest('No changes provided');
    }

    if (clientPatch) {
      const updates: Record<string, string | null> = {};
      if (typeof clientPatch.first_name === 'string' && clientPatch.first_name.trim()) {
        updates.first_name = clientPatch.first_name.trim();
      }
      if (clientPatch.last_name === null || typeof clientPatch.last_name === 'string') {
        updates.last_name = coerceNullableString(clientPatch.last_name);
      }
      if (typeof clientPatch.email === 'string' && clientPatch.email.trim()) {
        updates.email = normalizeEmail(clientPatch.email);
      }
      if (clientPatch.phone === null || typeof clientPatch.phone === 'string') {
        updates.phone = coerceNullableString(clientPatch.phone);
      }
      if (Object.keys(updates).length > 0) {
        await ctx.providers.repository.updateClient(booking.client_id, updates);
      }
    }

    if (bookingPatch) {
      const updates: { notes?: string | null } = {};
      if (bookingPatch.notes === null || typeof bookingPatch.notes === 'string') {
        updates.notes = bookingPatch.notes === null ? null : bookingPatch.notes.slice(0, 4000);
      }
      if (Object.keys(updates).length > 0) {
        await ctx.providers.repository.updateBooking(booking.id, updates);
      }
    }

    const refreshedRows = await ctx.providers.repository.getOrganizerBookings({ client_id: booking.client_id });
    const refreshed = refreshedRows.find((row) => row.booking_id === booking.id) ?? null;
    return ok({ ok: true, booking: refreshed });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/admin/events/:eventId/late-access-links
export async function handleAdminCreateLateAccessLink(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  try {
    await requireAdminAccess(request, ctx.env);
    const eventId = params.eventId?.trim();
    if (!eventId) throw badRequest('eventId is required');

    const event = await ctx.providers.repository.getEventById(eventId);
    if (!event) throw notFound('Event not found');

    const rawToken = generateToken();
    const tokenHash = await hashToken(rawToken);
    const expiresAt = new Date(new Date(event.ends_at).getTime() + 2 * 60 * 60_000).toISOString();

    await ctx.providers.repository.revokeActiveEventLateAccessLinks(event.id);
    await ctx.providers.repository.createEventLateAccessLink({
      event_id: event.id,
      token_hash: tokenHash,
      expires_at: expiresAt,
      created_by_client_id: null,
    });

    return created({
      event_id: event.id,
      expires_at: expiresAt,
      url: buildLateAccessUrl(event, ctx.env.SITE_URL, rawToken),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/admin/config
export async function handleAdminGetConfig(request: Request, ctx: AppContext): Promise<Response> {
  try {
    await requireAdminAccess(request, ctx.env);
    const overrides = getAllOverrides();
    const services = SERVICE_MODES.map(({ key, label, modes }) => {
      const envMode = getEnvMode(key, ctx.env);
      const overrideMode = overrides[key] ?? null;
      const effectiveMode = overrideMode ?? envMode;
      return { key, label, effective_mode: effectiveMode, env_mode: envMode, override_mode: overrideMode, modes };
    });
    return ok({ services });
  } catch (err) {
    return errorResponse(err);
  }
}

// PATCH /api/admin/config
export async function handleAdminPatchConfig(request: Request, ctx: AppContext): Promise<Response> {
  try {
    await requireAdminAccess(request, ctx.env);
    const body = await parseJsonBody(request);
    const key = typeof body.key === 'string' ? body.key as ServiceKey : null;
    const mode = typeof body.mode === 'string' ? body.mode : null;
    if (!key || !mode) throw badRequest('key and mode are required');

    const serviceDef = SERVICE_MODES.find((s) => s.key === key);
    if (!serviceDef) throw badRequest(`Unknown service: ${key}`);

    const modeDef = serviceDef.modes.find((m) => m.value === mode);
    if (!modeDef) throw badRequest(`Unknown mode '${mode}' for service '${key}'`);
    if (!modeDef.wired) throw badRequest(`Mode '${mode}' is not yet wired for '${key}'`);

    if (mode === getEnvMode(key, ctx.env)) {
      clearOverride(key);
    } else {
      setOverride(key, mode);
    }

    const overrides = getAllOverrides();
    const envMode = getEnvMode(key, ctx.env);
    return ok({
      key,
      effective_mode: overrides[key] ?? envMode,
      env_mode: envMode,
      override_mode: overrides[key] ?? null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function getEnvMode(key: ServiceKey, env: Env): string {
  const map: Record<ServiceKey, string> = {
    repository: env.REPOSITORY_MODE,
    email:      env.EMAIL_MODE,
    calendar:   env.CALENDAR_MODE,
    payments:   env.PAYMENTS_MODE,
    antibot:    env.ANTIBOT_MODE,
  };
  return map[key];
}

// POST /api/admin/reminder-subscriptions
export async function handleAdminCreateReminderSubscription(
  request: Request,
  ctx: AppContext,
): Promise<Response> {
  try {
    await requireAdminAccess(request, ctx.env);
    const body = await request.json() as Record<string, unknown>;
    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    if (!email) throw badRequest('email is required');

    const subscription = await ctx.providers.repository.createOrUpdateEventReminderSubscription({
      email,
      first_name: coerceNullableString(body.first_name),
      last_name: coerceNullableString(body.last_name),
      phone: coerceNullableString(body.phone),
      event_family: coerceNullableString(body.event_family) ?? 'illuminate_evenings',
    });

    return created({
      ok: true,
      id: subscription.id,
      email: subscription.email,
      event_family: subscription.event_family,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
