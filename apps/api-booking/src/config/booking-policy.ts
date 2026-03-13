import rawBookingPolicy from './booking-policy.json';

export interface BookingPolicyConfig {
  nonPaidConfirmationWindowMinutes: number;
  payNowCheckoutWindowMinutes: number;
  payNowReminderGraceMinutes: number;
  paymentDueBeforeStartHours: number;
  processingMaxAttempts: number;
  selfServiceLockWindowHours: number;
  publicEventCutoffAfterStartMinutes: number;
  slotLeadTimeHours: number;
  eventLateAccessLinkExpiryHours: number;
  adminManageTokenExpiryMinutes: number;
  sideEffectProcessingTimeoutMinutes: number;
  paymentDueReminderLeadHours: number;
  paymentDueReminderSleepHoursStart: number;
  paymentDueReminderSleepHoursEnd: number;
  paymentDueReminderFallbackHourPreviousDay: number;
  paymentDueReminderFallbackHourNextMorning: number;
  eventReminderLeadHours: number;
}

const POSITIVE_INTEGER_FIELDS: Array<keyof BookingPolicyConfig> = [
  'nonPaidConfirmationWindowMinutes',
  'payNowCheckoutWindowMinutes',
  'payNowReminderGraceMinutes',
  'paymentDueBeforeStartHours',
  'processingMaxAttempts',
  'selfServiceLockWindowHours',
  'publicEventCutoffAfterStartMinutes',
  'slotLeadTimeHours',
  'eventLateAccessLinkExpiryHours',
  'adminManageTokenExpiryMinutes',
  'sideEffectProcessingTimeoutMinutes',
  'paymentDueReminderLeadHours',
  'paymentDueReminderFallbackHourPreviousDay',
  'paymentDueReminderFallbackHourNextMorning',
  'eventReminderLeadHours',
];

const HOUR_FIELDS: Array<keyof BookingPolicyConfig> = [
  'paymentDueReminderSleepHoursStart',
  'paymentDueReminderSleepHoursEnd',
  'paymentDueReminderFallbackHourPreviousDay',
  'paymentDueReminderFallbackHourNextMorning',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateBookingPolicyConfig(input: unknown): BookingPolicyConfig {
  if (!isRecord(input)) {
    throw new Error('booking_policy_config_invalid_shape');
  }

  const policy = input as Partial<Record<keyof BookingPolicyConfig, unknown>>;

  for (const field of POSITIVE_INTEGER_FIELDS) {
    const value = policy[field];
    if (!Number.isInteger(value) || Number(value) <= 0) {
      throw new Error(`booking_policy_config_invalid_${field}`);
    }
  }

  for (const field of HOUR_FIELDS) {
    const value = Number(policy[field]);
    if (!Number.isInteger(value) || value < 0 || value > 23) {
      throw new Error(`booking_policy_config_invalid_${field}`);
    }
  }

  if (Number(policy.paymentDueReminderSleepHoursStart) === Number(policy.paymentDueReminderSleepHoursEnd)) {
    throw new Error('booking_policy_config_invalid_sleep_window');
  }

  return {
    nonPaidConfirmationWindowMinutes: Number(policy.nonPaidConfirmationWindowMinutes),
    payNowCheckoutWindowMinutes: Number(policy.payNowCheckoutWindowMinutes),
    payNowReminderGraceMinutes: Number(policy.payNowReminderGraceMinutes),
    paymentDueBeforeStartHours: Number(policy.paymentDueBeforeStartHours),
    processingMaxAttempts: Number(policy.processingMaxAttempts),
    selfServiceLockWindowHours: Number(policy.selfServiceLockWindowHours),
    publicEventCutoffAfterStartMinutes: Number(policy.publicEventCutoffAfterStartMinutes),
    slotLeadTimeHours: Number(policy.slotLeadTimeHours),
    eventLateAccessLinkExpiryHours: Number(policy.eventLateAccessLinkExpiryHours),
    adminManageTokenExpiryMinutes: Number(policy.adminManageTokenExpiryMinutes),
    sideEffectProcessingTimeoutMinutes: Number(policy.sideEffectProcessingTimeoutMinutes),
    paymentDueReminderLeadHours: Number(policy.paymentDueReminderLeadHours),
    paymentDueReminderSleepHoursStart: Number(policy.paymentDueReminderSleepHoursStart),
    paymentDueReminderSleepHoursEnd: Number(policy.paymentDueReminderSleepHoursEnd),
    paymentDueReminderFallbackHourPreviousDay: Number(policy.paymentDueReminderFallbackHourPreviousDay),
    paymentDueReminderFallbackHourNextMorning: Number(policy.paymentDueReminderFallbackHourNextMorning),
    eventReminderLeadHours: Number(policy.eventReminderLeadHours),
  };
}

const BOOKING_POLICY_DEFAULTS = validateBookingPolicyConfig(rawBookingPolicy);

export const DEFAULT_BOOKING_POLICY: BookingPolicyConfig = {
  ...BOOKING_POLICY_DEFAULTS,
};

export function applyBookingPolicyOverridesForTests(overrides: Partial<BookingPolicyConfig>): void {
  const merged = validateBookingPolicyConfig({
    ...DEFAULT_BOOKING_POLICY,
    ...overrides,
  });
  Object.assign(DEFAULT_BOOKING_POLICY, merged);
}

export function resetBookingPolicyForTests(): void {
  Object.assign(DEFAULT_BOOKING_POLICY, BOOKING_POLICY_DEFAULTS);
}

function formatHoursLabel(hours: number): string {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export function getBookingPolicyText(): string {
  const lockWindowLabel = formatHoursLabel(DEFAULT_BOOKING_POLICY.selfServiceLockWindowHours);
  return [
    'Booking policy',
    `You can reschedule or cancel your booking up to ${lockWindowLabel} before the session.`,
    `Within ${lockWindowLabel} of the session, bookings can no longer be changed online and are non-refundable.`,
    'If an emergency occurs, please contact me directly.',
  ].join('\n');
}
