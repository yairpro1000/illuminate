import { DEFAULT_BOOKING_POLICY } from '../config/booking-policy.js';

/**
 * Computes the time to send a payment reminder for a pay-later booking.
 *
 * Rules:
 *   preferred = payment-due-threshold - configured lead hours
 *   if preferred falls in configured sleep hours -> use configured fallback hour the day before threshold
 *   if that fallback has already passed -> use configured fallback hour next morning
 */
export function computePaymentDueReminderTime(
  paymentDueAt: Date,
  timezone: string,
  now = new Date(),
): Date {
  const preferred = new Date(
    paymentDueAt.getTime() - DEFAULT_BOOKING_POLICY.paymentDueReminderLeadHours * 60 * 60 * 1000,
  );

  if (!isInSleepHours(preferred, timezone)) {
    return preferred;
  }

  // Try the configured fallback hour on the day before the threshold.
  const dayBefore = new Date(paymentDueAt);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const previousDayFallback = setLocalHour(
    dayBefore,
    DEFAULT_BOOKING_POLICY.paymentDueReminderFallbackHourPreviousDay,
    0,
    timezone,
  );
  if (previousDayFallback > now) {
    return previousDayFallback;
  }

  // Fall back to the configured next-morning send hour after now.
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return setLocalHour(
    tomorrow,
    DEFAULT_BOOKING_POLICY.paymentDueReminderFallbackHourNextMorning,
    0,
    timezone,
  );
}

/**
 * Computes the configured pre-event reminder time for a confirmed booking/event.
 * Returns null if the window has already passed.
 */
export function compute24hReminderTime(startsAt: Date, now = new Date()): Date | null {
  const reminder = new Date(
    startsAt.getTime() - DEFAULT_BOOKING_POLICY.eventReminderLeadHours * 60 * 60 * 1000,
  );
  return reminder > now ? reminder : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLocalHour(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // 'hour12: false' may return '24' for midnight in some environments
  const n = parseInt(h, 10);
  return n === 24 ? 0 : n;
}

function isInSleepHours(date: Date, timezone: string): boolean {
  const h = getLocalHour(date, timezone);
  const start = DEFAULT_BOOKING_POLICY.paymentDueReminderSleepHoursStart;
  const end = DEFAULT_BOOKING_POLICY.paymentDueReminderSleepHoursEnd;
  return start > end ? h >= start || h < end : h >= start && h < end;
}

/**
 * Returns a Date representing the given hour:minute in `timezone` on the
 * calendar day of `reference`. Uses a correction loop to handle DST.
 */
function setLocalHour(reference: Date, targetHour: number, targetMinute: number, timezone: string): Date {
  // Get the date parts in the target timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(reference);

  const year  = parts.find((p) => p.type === 'year')?.value  ?? '2000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day   = parts.find((p) => p.type === 'day')?.value   ?? '01';

  // Naive UTC candidate
  const naiveUtc = new Date(
    `${year}-${month}-${day}T${pad(targetHour)}:${pad(targetMinute)}:00Z`,
  );

  // Measure what local hour that UTC resolves to, then correct
  const actualHour = getLocalHour(naiveUtc, timezone);
  const errorMs = (actualHour - targetHour) * 60 * 60 * 1000;

  return new Date(naiveUtc.getTime() - errorMs);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
