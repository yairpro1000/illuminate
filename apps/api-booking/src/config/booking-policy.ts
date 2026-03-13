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

export const BOOKING_POLICY_CONFIG_RELATIVE_PATH = 'apps/api-booking/src/config/booking-policy.json';

export interface BookingPolicyTimingDelayRow {
  name: string;
  keyname: keyof BookingPolicyConfig;
  value: number;
  description: string;
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

const BOOKING_POLICY_TIMING_DELAY_FIELDS: ReadonlyArray<{
  keyname: keyof BookingPolicyConfig;
  name: string;
  description: string;
}> = [
  {
    keyname: 'nonPaidConfirmationWindowMinutes',
    name: 'Non-paid confirmation window',
    description: 'Minutes allowed to confirm a free or pay-later booking before it expires.',
  },
  {
    keyname: 'payNowCheckoutWindowMinutes',
    name: 'Pay-now checkout window',
    description: 'Minutes allowed to complete a pay-now checkout before payment verification expires.',
  },
  {
    keyname: 'payNowReminderGraceMinutes',
    name: 'Pay-now reminder grace period',
    description: 'Minutes used as the short follow-up grace delay after a pay-now confirmation flow.',
  },
  {
    keyname: 'paymentDueBeforeStartHours',
    name: 'Payment due threshold',
    description: 'Hours before the booking start when payment becomes formally due.',
  },
  {
    keyname: 'processingMaxAttempts',
    name: 'Side-effect max attempts',
    description: 'Maximum retry attempts allowed before a side effect becomes dead.',
  },
  {
    keyname: 'selfServiceLockWindowHours',
    name: 'Self-service lock window',
    description: 'Hours before the booking start when online cancel and reschedule actions are locked.',
  },
  {
    keyname: 'publicEventCutoffAfterStartMinutes',
    name: 'Public event cutoff after start',
    description: 'Minutes after an event starts when normal public registration is considered closed.',
  },
  {
    keyname: 'slotLeadTimeHours',
    name: 'Slot lead time',
    description: 'Hours of minimum lead time required before a slot can appear as bookable.',
  },
  {
    keyname: 'eventLateAccessLinkExpiryHours',
    name: 'Late-access link expiry',
    description: 'Hours after an event ends that an organizer-created late-access booking link remains valid.',
  },
  {
    keyname: 'adminManageTokenExpiryMinutes',
    name: 'Admin manage token expiry',
    description: 'Minutes that a generated admin manage token stays valid after creation.',
  },
  {
    keyname: 'sideEffectProcessingTimeoutMinutes',
    name: 'Stale processing timeout',
    description: 'Minutes after which a stuck processing side effect is reset back to pending.',
  },
  {
    keyname: 'paymentDueReminderLeadHours',
    name: 'Payment reminder lead time',
    description: 'Hours before the payment due threshold when the preferred reminder send time is scheduled.',
  },
  {
    keyname: 'paymentDueReminderSleepHoursStart',
    name: 'Reminder sleep window start',
    description: 'Local hour when payment reminders stop being sent for the night.',
  },
  {
    keyname: 'paymentDueReminderSleepHoursEnd',
    name: 'Reminder sleep window end',
    description: 'Local hour when payment reminders can resume in the morning.',
  },
  {
    keyname: 'paymentDueReminderFallbackHourPreviousDay',
    name: 'Reminder fallback hour previous day',
    description: 'Local hour used on the previous day when the preferred reminder time lands in sleep hours.',
  },
  {
    keyname: 'paymentDueReminderFallbackHourNextMorning',
    name: 'Reminder fallback hour next morning',
    description: 'Local hour used the next morning if the previous-day fallback time has already passed.',
  },
  {
    keyname: 'eventReminderLeadHours',
    name: 'Event reminder lead time',
    description: 'Hours before the booking or event start when the reminder is scheduled.',
  },
];

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

export function listBookingPolicyTimingDelayRows(
  policy: BookingPolicyConfig = DEFAULT_BOOKING_POLICY,
): BookingPolicyTimingDelayRow[] {
  return BOOKING_POLICY_TIMING_DELAY_FIELDS.map((field) => ({
    name: field.name,
    keyname: field.keyname,
    value: policy[field.keyname],
    description: field.description,
  }));
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
