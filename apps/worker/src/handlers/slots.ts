import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';

const SESSION_DURATION_MS = 60 * 60 * 1000; // 1 hour

// Working hours in local time: slot start times (hour, minute)
const SLOT_STARTS = [
  { h:  9, m:  0 },
  { h: 11, m:  0 },
  { h: 14, m: 30 },
  { h: 16, m: 30 },
];

export async function handleGetSlots(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');
    const tz   = url.searchParams.get('tz') ?? 'Europe/Zurich';

    if (!from || !to) throw badRequest('from and to query params are required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw badRequest('from and to must be YYYY-MM-DD');
    }

    const [busyTimes, heldSlots] = await Promise.all([
      ctx.providers.calendar.getBusyTimes(from, to),
      ctx.providers.repository.getHeldSlots(from, to),
    ]);

    const allBusy = [...busyTimes, ...heldSlots];

    // Generate candidate slots for every weekday in the range
    const slots: Array<{ start: string; end: string }> = [];
    const cur = new Date(from + 'T12:00:00Z');
    const end = new Date(to   + 'T12:00:00Z');

    while (cur <= end) {
      const dow = cur.getUTCDay();
      if (dow !== 0 && dow !== 6) { // Mon–Fri only
        const ymd = cur.toISOString().slice(0, 10);

        for (const { h, m } of SLOT_STARTS) {
          // Build ISO start in the requested timezone — approximate via naive UTC+offset
          // The real Google Calendar integration will use proper IANA resolution.
          // For Europe/Zurich (+01 winter / +02 summer) we use a simple UTC+1 offset here.
          const startIso = `${ymd}T${pad(h)}:${pad(m)}:00+01:00`;
          const endIso   = new Date(new Date(startIso).getTime() + SESSION_DURATION_MS).toISOString();

          const startMs = new Date(startIso).getTime();
          const endMs   = new Date(endIso).getTime();

          const overlaps = allBusy.some((b) => {
            const bStart = new Date(b.start).getTime();
            const bEnd   = new Date(b.end).getTime();
            return startMs < bEnd && endMs > bStart;
          });

          if (!overlaps) {
            slots.push({ start: startIso, end: endIso });
          }
        }
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    return ok({ timezone: tz, slots });
  } catch (err) {
    return errorResponse(err);
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
