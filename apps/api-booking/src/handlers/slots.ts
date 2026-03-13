import type { AppContext } from '../router.js';
import { badRequest, errorResponse, jsonResponse } from '../lib/errors.js';
import { getBookingPolicyConfig } from '../domain/booking-effect-policy.js';

// ── Slot rules ────────────────────────────────────────────────────────────────

// Intro conversation (30 min) — possible start hours
const INTRO_STARTS = [9, 10, 11, 12, 14, 15, 16, 17, 18, 19];
const INTRO_DURATION_MS = 30 * 60 * 1000;

// Other sessions (60–90 min) — use 90 min for conflict detection, Mon–Fri only
const SESSION_STARTS = [9, 11, 14, 16, 18];
const SESSION_DURATION_MS = 90 * 60 * 1000;
type SlotType = 'intro' | 'session';

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleGetSlots(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const policy = await getBookingPolicyConfig(ctx.providers.repository);
    const url      = new URL(request.url);
    const from     = url.searchParams.get('from');
    const to       = url.searchParams.get('to');
    const tz       = url.searchParams.get('tz') ?? ctx.env.TIMEZONE ?? 'Europe/Zurich';
    const typeParam = url.searchParams.get('type');

    if (!from || !to) throw badRequest('from and to query params are required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw badRequest('from and to must be YYYY-MM-DD');
    }
    if (!typeParam) throw badRequest('type query param is required');
    if (typeParam !== 'intro' && typeParam !== 'session') {
      throw badRequest('type must be "intro" or "session"');
    }
    const slotType = typeParam as SlotType;

    console.log('slots request', { from, to, tz, type: slotType });

    let busyTimes: Array<{ start: string; end: string }>;
    try {
      busyTimes = await ctx.providers.calendar.getBusyTimes(from, to);
    } catch (err) {
      console.error('slots: calendar unavailable', err instanceof Error ? err.message : String(err));
      return jsonResponse({ ok: false, message: 'Calendar temporarily unavailable' }, 500);
    }

    let heldSlots: Array<{ start: string; end: string }>;
    try {
      heldSlots = await ctx.providers.repository.getHeldSlots(from, to);
    } catch (err) {
      console.error('slots: repository unavailable', err instanceof Error ? err.message : String(err));
      return jsonResponse({ ok: false, message: 'Calendar temporarily unavailable' }, 500);
    }

    const allBusy = [...busyTimes, ...heldSlots];

    // Generate candidate slots for every weekday in the range
    const slots: Array<{ type: SlotType; start: string; end: string }> = [];
    const cur = new Date(from + 'T12:00:00Z');
    const end = new Date(to   + 'T12:00:00Z');

    while (cur <= end) {
      const dow = cur.getUTCDay();
      if (dow !== 0 && dow !== 6) { // Mon–Fri only
        const ymd = cur.toISOString().slice(0, 10);

        if (slotType === 'intro') {
          for (const h of INTRO_STARTS) {
            addCandidate('intro', ymd, h, INTRO_DURATION_MS, tz, allBusy, slots, policy.slotLeadTimeHours);
          }
        } else {
          for (const h of SESSION_STARTS) {
            addCandidate('session', ymd, h, SESSION_DURATION_MS, tz, allBusy, slots, policy.slotLeadTimeHours);
          }
        }
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    // Sort chronologically (ISO strings sort correctly within the same offset)
    slots.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    return jsonResponse({ ok: true, timezone: tz, slots });
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function addCandidate(
  type:       SlotType,
  ymd:        string,
  h:          number,
  durationMs: number,
  tz:         string,
  allBusy:    Array<{ start: string; end: string }>,
  out:        Array<{ type: SlotType; start: string; end: string }>,
  slotLeadTimeHours: number,
): void {
  const startIso = localTimeToISO(ymd, h, 0, tz);
  const startMs  = new Date(startIso).getTime();
  const endMs    = startMs + durationMs;

  if (startMs < Date.now() + slotLeadTimeHours * 60 * 60 * 1000) {
    return;
  }

  const overlaps = allBusy.some(b => {
    const bStart = new Date(b.start).getTime();
    const bEnd   = new Date(b.end).getTime();
    return startMs < bEnd && endMs > bStart;
  });

  if (!overlaps) {
    out.push({ type, start: startIso, end: new Date(endMs).toISOString() });
  }
}

/**
 * Returns the UTC offset in minutes for the given IANA timezone at the given UTC instant.
 * Uses Intl.DateTimeFormat to read the wall-clock time and compute the difference.
 */
function getUtcOffsetMinutes(tz: string, date: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year:     'numeric',
    month:    'numeric',
    day:      'numeric',
    hour:     'numeric',
    minute:   'numeric',
    second:   'numeric',
    hour12:   false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) =>
    parseInt(parts.find(p => p.type === type)!.value, 10);

  const h = get('hour');
  const localMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    h === 24 ? 0 : h, // hour12:false can yield 24 at midnight
    get('minute'),
    get('second'),
  );
  return (localMs - date.getTime()) / 60000;
}

/**
 * Converts a local wall-clock time (YYYY-MM-DD HH:00) in the given IANA timezone
 * to an ISO 8601 string with the explicit UTC offset, e.g. "2026-03-20T09:00:00+01:00".
 *
 * Uses the noon-of-day UTC instant as the reference for offset lookup, which is
 * safely away from any DST boundary (Europe/Zurich transitions happen at 02:00/03:00).
 */
function localTimeToISO(dateStr: string, h: number, m: number, tz: string): string {
  const refDate   = new Date(`${dateStr}T12:00:00Z`);
  const offsetMin = getUtcOffsetMinutes(tz, refDate);

  const sign  = offsetMin >= 0 ? '+' : '-';
  const absH  = Math.floor(Math.abs(offsetMin) / 60);
  const absM  = Math.abs(offsetMin) % 60;

  return `${dateStr}T${pad(h)}:${pad(m)}:00${sign}${pad(absH)}:${pad(absM)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
