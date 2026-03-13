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
    description: 'מספר הדקות שבהן אפשר לאשר הזמנה חינמית או תשלום-אחר-כך לפני שפג התוקף שלה.',
  },
  {
    keyname: 'payNowCheckoutWindowMinutes',
    name: 'Pay-now checkout window',
    description: 'מספר הדקות שבהן אפשר להשלים תשלום מיידי לפני שפג חלון אימות התשלום.',
  },
  {
    keyname: 'payNowReminderGraceMinutes',
    name: 'Pay-now reminder grace period',
    description: 'מספר הדקות של עיכוב קצר לפני שליחת תזכורת המשך בתהליך של תשלום מיידי.',
  },
  {
    keyname: 'paymentDueBeforeStartHours',
    name: 'Payment due threshold',
    description: 'מספר השעות לפני תחילת ההזמנה שבהן התשלום נחשב רשמית כמועד לפירעון.',
  },
  {
    keyname: 'processingMaxAttempts',
    name: 'Side-effect max attempts',
    description: 'מספר ניסיונות החזרה המקסימלי לפני שתופעת לוואי מסומנת כלא ניתנת להמשך.',
  },
  {
    keyname: 'selfServiceLockWindowHours',
    name: 'Self-service lock window',
    description: 'מספר השעות לפני תחילת ההזמנה שבהן אי אפשר יותר לבטל או לשנות מועד אונליין.',
  },
  {
    keyname: 'publicEventCutoffAfterStartMinutes',
    name: 'Public event cutoff after start',
    description: 'מספר הדקות אחרי תחילת אירוע שלאחריהן ההרשמה הציבורית הרגילה נחשבת סגורה.',
  },
  {
    keyname: 'slotLeadTimeHours',
    name: 'Slot lead time',
    description: 'מספר שעות ההתראה המינימלי שנדרש לפני שסלוט יכול להופיע כזמין להזמנה.',
  },
  {
    keyname: 'eventLateAccessLinkExpiryHours',
    name: 'Late-access link expiry',
    description: 'מספר השעות אחרי סיום אירוע שבהן קישור הזמנה מאוחרת שנוצר על ידי המארגן עדיין תקף.',
  },
  {
    keyname: 'adminManageTokenExpiryMinutes',
    name: 'Admin manage token expiry',
    description: 'מספר הדקות שטוקן ניהול שנוצר על ידי אדמין נשאר תקף לאחר יצירתו.',
  },
  {
    keyname: 'sideEffectProcessingTimeoutMinutes',
    name: 'Stale processing timeout',
    description: 'מספר הדקות שלאחריהן תופעת לוואי שנתקעה בעיבוד מאופסת חזרה למצב ממתין.',
  },
  {
    keyname: 'paymentDueReminderLeadHours',
    name: 'Payment reminder lead time',
    description: 'מספר השעות לפני מועד פירעון התשלום שבו מתוזמן זמן השליחה המועדף של התזכורת.',
  },
  {
    keyname: 'paymentDueReminderSleepHoursStart',
    name: 'Reminder sleep window start',
    description: 'השעה המקומית שבה מפסיקים לשלוח תזכורות תשלום במהלך הלילה.',
  },
  {
    keyname: 'paymentDueReminderSleepHoursEnd',
    name: 'Reminder sleep window end',
    description: 'השעה המקומית שבה אפשר לחזור לשלוח תזכורות תשלום בבוקר.',
  },
  {
    keyname: 'paymentDueReminderFallbackHourPreviousDay',
    name: 'Reminder fallback hour previous day',
    description: 'השעה המקומית ביום הקודם שבה משתמשים אם זמן התזכורת המועדף נופל בתוך שעות הלילה.',
  },
  {
    keyname: 'paymentDueReminderFallbackHourNextMorning',
    name: 'Reminder fallback hour next morning',
    description: 'השעה המקומית בבוקר הבא שבה משתמשים אם שעת ברירת המחדל של היום הקודם כבר חלפה.',
  },
  {
    keyname: 'eventReminderLeadHours',
    name: 'Event reminder lead time',
    description: 'מספר השעות לפני תחילת ההזמנה או האירוע שבהן התזכורת מתוזמנת.',
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
  return BOOKING_POLICY_TIMING_DELAY_FIELDS
    .map((field) => ({
      name: field.name,
      keyname: field.keyname,
      value: policy[field.keyname],
      description: field.description,
    }))
    .sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));
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
