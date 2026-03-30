import type { AppContext } from '../router.js';
import { badRequest, unauthorized, internalError, jsonResponse } from '../lib/errors.js';
import { verifyAdminManageToken } from '../services/token-service.js';
import { localDateTimeToIso } from '../services/session-availability.js';
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

  const now = new Date();

  // Generate every 15-minute slot for each day in [from, to].
  const slots: Array<{ start: string; end: string; blocked: boolean }> = [];

  // Iterate day by day using UTC-based dates so we never cross DST boundaries mid-loop.
  const fromDate = new Date(from + 'T12:00:00Z');
  const toDate   = new Date(to   + 'T12:00:00Z');

  for (const cur = new Date(fromDate); cur <= toDate; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const yyyy = cur.getUTCFullYear();
    const mm   = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(cur.getUTCDate()).padStart(2, '0');
    const dayStr = `${yyyy}-${mm}-${dd}`;

    for (let minuteOfDay = ADMIN_SLOT_START_HOUR * 60;
         minuteOfDay < ADMIN_SLOT_END_HOUR * 60;
         minuteOfDay += ADMIN_SLOT_STEP_MIN) {
      const startHour = Math.floor(minuteOfDay / 60);
      const startMin  = minuteOfDay % 60;
      const endMin    = minuteOfDay + ADMIN_SLOT_STEP_MIN;
      const endHour   = Math.floor(endMin / 60);
      const endMinute = endMin % 60;

      // Use localDateTimeToIso so the ISO strings carry the correct UTC offset
      // for the requested timezone (e.g. "2026-03-30T16:00:00+02:00").
      // This ensures new Date(startIso) gives the correct UTC instant for both
      // the past-time check and the calendar busy-time overlap comparison.
      const startIso = localDateTimeToIso(dayStr, startHour, startMin, tz);
      const endIso   = localDateTimeToIso(dayStr, endHour, endMinute, tz);

      const slotStart = new Date(startIso);
      const slotEnd   = new Date(endIso);

      const isPast    = slotStart < now;
      const isBusy    = overlapsBusy(slotStart, slotEnd, busyTimes);

      slots.push({
        start:   startIso,
        end:     endIso,
        blocked: isPast || isBusy,
      });
    }
  }

  return jsonResponse({ ok: true, timezone: tz, slots });
}
