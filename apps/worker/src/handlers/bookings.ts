import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { createPayNowBooking, createPayLaterBooking } from '../services/booking-service.js';

// POST /api/bookings/pay-now
export async function handlePayNow(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;

    const slotStart  = requireString(body, 'slot_start');
    const slotEnd    = requireString(body, 'slot_end');
    const clientName = requireString(body, 'client_name');
    const clientEmail = requireString(body, 'client_email');

    if (!slotStart || !slotEnd || !clientName || !clientEmail) {
      throw badRequest('slot_start, slot_end, client_name, client_email are required');
    }

    const result = await createPayNowBooking(
      {
        slotStart,
        slotEnd,
        timezone:            (body['timezone'] as string | undefined) ?? 'Europe/Zurich',
        clientName,
        clientEmail,
        clientPhone:         (body['client_phone'] as string | null) ?? null,
        reminderEmailOptIn:  Boolean(body['reminder_email_opt_in']),
        reminderWhatsappOptIn: Boolean(body['reminder_whatsapp_opt_in']),
        turnstileToken:      (body['turnstile_token'] as string) ?? '',
        remoteIp:            request.headers.get('CF-Connecting-IP'),
      },
      {
        providers:  ctx.providers,
        env:        ctx.env,
        logger:     ctx.logger,
        requestId:  ctx.requestId,
      },
    );

    return ok({
      ok:                     true,
      booking_id:             result.bookingId,
      checkout_url:           result.checkoutUrl,
      checkout_hold_expires_at: result.checkoutHoldExpiresAt,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/bookings/pay-later
export async function handlePayLater(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;

    const slotStart  = requireString(body, 'slot_start');
    const slotEnd    = requireString(body, 'slot_end');
    const clientName = requireString(body, 'client_name');
    const clientEmail = requireString(body, 'client_email');

    if (!slotStart || !slotEnd || !clientName || !clientEmail) {
      throw badRequest('slot_start, slot_end, client_name, client_email are required');
    }

    const result = await createPayLaterBooking(
      {
        slotStart,
        slotEnd,
        timezone:             (body['timezone'] as string | undefined) ?? 'Europe/Zurich',
        clientName,
        clientEmail,
        clientPhone:          (body['client_phone'] as string | null) ?? null,
        reminderEmailOptIn:   Boolean(body['reminder_email_opt_in']),
        reminderWhatsappOptIn: Boolean(body['reminder_whatsapp_opt_in']),
        turnstileToken:       (body['turnstile_token'] as string) ?? '',
        remoteIp:             request.headers.get('CF-Connecting-IP'),
      },
      {
        providers: ctx.providers,
        env:       ctx.env,
        logger:    ctx.logger,
        requestId: ctx.requestId,
      },
    );

    return ok({
      ok:         true,
      booking_id: result.bookingId,
      status:     result.status,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${key} is required`);
  return v.trim();
}
