/**
 * Computes the time to send a payment-due reminder for a pay-later booking.
 *
 * Rules (from state_machines.md):
 *   preferred = payment_due_at - 6h
 *   if preferred falls in 22:00–08:00 local → use 18:00 day before payment_due_at
 *   if 18:00 day before has already passed   → use 08:00 next reasonable morning
 */
export function computePaymentDueReminderTime(
  paymentDueAt: Date,
  timezone: string,
  now = new Date(),
): Date {
  const preferred = new Date(paymentDueAt.getTime() - 6 * 60 * 60 * 1000);

  if (!isInSleepHours(preferred, timezone)) {
    return preferred;
  }

  // Try 18:00 the day before payment_due_at
  const dayBefore = new Date(paymentDueAt);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const at18 = setLocalHour(dayBefore, 18, 0, timezone);
  if (at18 > now) {
    return at18;
  }

  // Fall back to 08:00 next reasonable morning after now
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return setLocalHour(tomorrow, 8, 0, timezone);
}

/**
 * Computes the 24h-before reminder time for a confirmed booking/event.
 * Returns null if the window has already passed.
 */
export function compute24hReminderTime(startsAt: Date, now = new Date()): Date | null {
  const reminder = new Date(startsAt.getTime() - 24 * 60 * 60 * 1000);
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
  return h >= 22 || h < 8;
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
