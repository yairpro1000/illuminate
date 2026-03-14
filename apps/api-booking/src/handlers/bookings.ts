import type { AppContext } from '../router.js';
import { ok, badRequest } from '../lib/errors.js';
import { createPayNowBooking, createPayLaterBooking } from '../services/booking-service.js';

// POST /api/bookings/pay-now
export async function handlePayNow(request: Request, ctx: AppContext): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;

  const slotStart = requireString(body, 'slot_start');
  const slotEnd = requireString(body, 'slot_end');
  const clientEmail = requireString(body, 'client_email');
  const clientName = resolveClientName(body);
  const couponCode = typeof body['coupon_code'] === 'string' ? body['coupon_code'] : null;
  const offerSlug = typeof body['offer_slug'] === 'string' ? body['offer_slug'].trim() : null;

  const sessionTypeRaw = typeof body['type'] === 'string' ? body['type'].trim().toLowerCase() : 'intro';
  const sessionType = sessionTypeRaw === 'session' ? 'session' : 'intro';

  const result = await createPayNowBooking(
    {
      slotStart,
      slotEnd,
      timezone: (body['timezone'] as string | undefined) ?? 'Europe/Zurich',
      sessionType,
      offerSlug,
      clientName,
      clientEmail,
      clientPhone: (body['client_phone'] as string | null) ?? null,
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

  return ok({
    booking_id: result.bookingId,
    checkout_url: result.checkoutUrl,
    checkout_hold_expires_at: result.checkoutHoldExpiresAt,
  });
}

// POST /api/bookings/pay-later
export async function handlePayLater(request: Request, ctx: AppContext): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;

  const slotStart = requireString(body, 'slot_start');
  const slotEnd = requireString(body, 'slot_end');
  const clientEmail = requireString(body, 'client_email');
  const clientName = resolveClientName(body);
  const couponCode = typeof body['coupon_code'] === 'string' ? body['coupon_code'] : null;
  const offerSlug = typeof body['offer_slug'] === 'string' ? body['offer_slug'].trim() : null;

  const sessionTypeRaw = typeof body['type'] === 'string' ? body['type'].trim().toLowerCase() : 'intro';
  const sessionType = sessionTypeRaw === 'session' ? 'session' : 'intro';

  const result = await createPayLaterBooking(
    {
      slotStart,
      slotEnd,
      timezone: (body['timezone'] as string | undefined) ?? 'Europe/Zurich',
      sessionType,
      offerSlug,
      clientName,
      clientEmail,
      clientPhone: (body['client_phone'] as string | null) ?? null,
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

  return ok({
    booking_id: result.bookingId,
    status: result.status,
  });
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${key} is required`);
  return v.trim();
}

function resolveClientName(body: Record<string, unknown>): string {
  const first = typeof body['first_name'] === 'string' ? body['first_name'].trim() : '';
  const last = typeof body['last_name'] === 'string' ? body['last_name'].trim() : '';
  const combined = [first, last].filter(Boolean).join(' ');
  if (combined) return combined;

  const clientName = typeof body['client_name'] === 'string' ? body['client_name'].trim() : '';
  if (clientName) return clientName;

  throw badRequest('client_name or first_name is required');
}
