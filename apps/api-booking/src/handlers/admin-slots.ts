import type { AppContext } from '../router.js';
import { badRequest, unauthorized, internalError, jsonResponse } from '../lib/errors.js';
import { verifyAdminManageToken } from '../services/token-service.js';
import type { TimeSlot } from '../types.js';

const ADMIN_SLOT_START_HOUR = 8;   // 08:00
const ADMIN_SLOT_END_HOUR   = 22;  // 22:00 (slots up to but not including 22:00)
const ADMIN_SLOT_STEP_MIN   = 15;

function requireIsoDate(value: string | null, fieldName: string): string {
  if (!value) throw badRequest(`${fieldName} query param is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`${fieldName} must be YYYY-MM-DD`);
  }
  return value;
}

function overlapsBusy(slotStart: Date, slotEnd: Date, busy: TimeSlot[]): boolean {
  const s = slotStart.getTime();
  const e = slotEnd.getTime();
  for (const b of busy) {
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    if (s < be && e > bs) return true;
  }
  return false;
}

/**
 * GET /api/slots/admin
 *
 * Returns every 15-minute slot between 08:00 and 22:00 for every day in the
 * requested range.  Each slot includes a `blocked` flag that is true when the
 * slot overlaps an existing calendar event.  No other availability rules are
 * applied (no lead time, no weekly limits, no availability windows).
 *
 * Auth: requires a valid admin manage token (cryptographic signature + expiry).
 * If `booking_id` is also supplied the token must match that booking; omitting
 * it skips the booking-id check so the same endpoint works for future admin
 * new-booking flows where no booking exists yet.
 */
export async function handleGetAdminSlots(request: Request, ctx: AppContext): Promise<Response> {
  const url = new URL(request.url);
  const from          = requireIsoDate(url.searchParams.get('from'), 'from');
  const to            = requireIsoDate(url.searchParams.get('to'), 'to');
  const tz            = url.searchParams.get('tz') ?? ctx.env.TIMEZONE ?? 'Europe/Zurich';
  const rawAdminToken = url.searchParams.get('admin_token') ?? '';
  const bookingId     = url.searchParams.get('booking_id') ?? '';

  if (!rawAdminToken) throw unauthorized('admin_token is required');

  const secret = String(ctx.env.ADMIN_MANAGE_TOKEN_SECRET || ctx.env.JOB_SECRET || '').trim();
  if (!secret) throw unauthorized('Admin token verification is not configured');

  const verified = await verifyAdminManageToken(rawAdminToken, secret);
  if (!verified) throw unauthorized('Invalid or expired admin token');

  // If the caller supplied a booking_id, the token must match it.
  // Omitting booking_id is allowed for admin-initiated new bookings.
  if (bookingId && verified.bookingId !== bookingId) {
    throw unauthorized('Admin token does not match the supplied booking_id');
  }

  // Fetch calendar busy times — the only rule we honour.
  const busyTimes = await ctx.providers.calendar.getBusyTimes(from, to).catch((err) => {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'admin_slots_calendar_failed',
      message: err instanceof Error ? err.message : String(err),
      context: { from, to, request_id: ctx.requestId },
    });
    throw internalError('Calendar temporarily unavailable');
  });

  // Generate every 15-minute slot for each day in [from, to].
  const slots: Array<{ start: string; end: string; blocked: boolean }> = [];

  const fromDate = new Date(from + 'T00:00:00');
  const toDate   = new Date(to   + 'T00:00:00');

  // Iterate day by day.
  for (const cur = new Date(fromDate); cur <= toDate; cur.setDate(cur.getDate() + 1)) {
    const yyyy = cur.getFullYear();
    const mm   = String(cur.getMonth() + 1).padStart(2, '0');
    const dd   = String(cur.getDate()).padStart(2, '0');
    const dayPrefix = `${yyyy}-${mm}-${dd}`;

    for (let minuteOfDay = ADMIN_SLOT_START_HOUR * 60;
         minuteOfDay < ADMIN_SLOT_END_HOUR * 60;
         minuteOfDay += ADMIN_SLOT_STEP_MIN) {
      const startH = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
      const startM = String(minuteOfDay % 60).padStart(2, '0');
      const endMin = minuteOfDay + ADMIN_SLOT_STEP_MIN;
      const endH   = String(Math.floor(endMin / 60)).padStart(2, '0');
      const endMStr = String(endMin % 60).padStart(2, '0');

      const startIso = `${dayPrefix}T${startH}:${startM}:00`;
      const endIso   = `${dayPrefix}T${endH}:${endMStr}:00`;

      // We build Date objects in the requested timezone using a known-safe trick:
      // append the tz offset by formatting the local time as-is and letting the
      // caller (frontend) interpret it in the booking timezone.
      // For busy-time comparison we use wall-clock Date objects (treating the
      // ISO string as if it were UTC, which is consistent across both sides).
      const slotStart = new Date(startIso);
      const slotEnd   = new Date(endIso);

      slots.push({
        start:   startIso,
        end:     endIso,
        blocked: overlapsBusy(slotStart, slotEnd, busyTimes),
      });
    }
  }

  return jsonResponse({ ok: true, timezone: tz, slots });
}
