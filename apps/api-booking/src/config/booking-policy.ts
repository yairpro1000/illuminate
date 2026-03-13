import type { IRepository } from '../providers/repository/interface.js';
import type { SystemSetting } from '../types.js';

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

export const BOOKING_POLICY_CONFIG_SOURCE = 'public.system_settings';

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

let bookingPolicyOverridesForTests: Partial<BookingPolicyConfig> = {};

function validateBookingPolicyConfig(input: Partial<Record<keyof BookingPolicyConfig, unknown>>): BookingPolicyConfig {
  for (const field of POSITIVE_INTEGER_FIELDS) {
    const value = input[field];
    if (!Number.isInteger(value) || Number(value) <= 0) {
      throw new Error(`booking_policy_config_invalid_${field}`);
    }
  }

  for (const field of HOUR_FIELDS) {
    const value = Number(input[field]);
    if (!Number.isInteger(value) || value < 0 || value > 23) {
      throw new Error(`booking_policy_config_invalid_${field}`);
    }
  }

  if (Number(input.paymentDueReminderSleepHoursStart) === Number(input.paymentDueReminderSleepHoursEnd)) {
    throw new Error('booking_policy_config_invalid_sleep_window');
  }

  return {
    nonPaidConfirmationWindowMinutes: Number(input.nonPaidConfirmationWindowMinutes),
    payNowCheckoutWindowMinutes: Number(input.payNowCheckoutWindowMinutes),
    payNowReminderGraceMinutes: Number(input.payNowReminderGraceMinutes),
    paymentDueBeforeStartHours: Number(input.paymentDueBeforeStartHours),
    processingMaxAttempts: Number(input.processingMaxAttempts),
    selfServiceLockWindowHours: Number(input.selfServiceLockWindowHours),
    publicEventCutoffAfterStartMinutes: Number(input.publicEventCutoffAfterStartMinutes),
    slotLeadTimeHours: Number(input.slotLeadTimeHours),
    eventLateAccessLinkExpiryHours: Number(input.eventLateAccessLinkExpiryHours),
    adminManageTokenExpiryMinutes: Number(input.adminManageTokenExpiryMinutes),
    sideEffectProcessingTimeoutMinutes: Number(input.sideEffectProcessingTimeoutMinutes),
    paymentDueReminderLeadHours: Number(input.paymentDueReminderLeadHours),
    paymentDueReminderSleepHoursStart: Number(input.paymentDueReminderSleepHoursStart),
    paymentDueReminderSleepHoursEnd: Number(input.paymentDueReminderSleepHoursEnd),
    paymentDueReminderFallbackHourPreviousDay: Number(input.paymentDueReminderFallbackHourPreviousDay),
    paymentDueReminderFallbackHourNextMorning: Number(input.paymentDueReminderFallbackHourNextMorning),
    eventReminderLeadHours: Number(input.eventReminderLeadHours),
  };
}

function getSettingMap(settings: SystemSetting[]): Map<string, SystemSetting> {
  return new Map(settings.map((setting) => [setting.keyname, setting]));
}

function readPositiveIntegerSetting(
  settings: Map<string, SystemSetting>,
  keyname: keyof BookingPolicyConfig,
): number {
  const row = settings.get(keyname);
  if (!row) throw new Error(`booking_policy_setting_missing_${keyname}`);
  const parsed = Number(row.value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`booking_policy_setting_invalid_${keyname}`);
  }
  return parsed;
}

function applyOverrides(policy: BookingPolicyConfig): BookingPolicyConfig {
  if (!Object.keys(bookingPolicyOverridesForTests).length) {
    return policy;
  }
  return validateBookingPolicyConfig({
    ...policy,
    ...bookingPolicyOverridesForTests,
  });
}

export function coerceBookingPolicyConfig(settings: SystemSetting[]): BookingPolicyConfig {
  const byKeyname = getSettingMap(settings);
  const policy = validateBookingPolicyConfig({
    nonPaidConfirmationWindowMinutes: readPositiveIntegerSetting(byKeyname, 'nonPaidConfirmationWindowMinutes'),
    payNowCheckoutWindowMinutes: readPositiveIntegerSetting(byKeyname, 'payNowCheckoutWindowMinutes'),
    payNowReminderGraceMinutes: readPositiveIntegerSetting(byKeyname, 'payNowReminderGraceMinutes'),
    paymentDueBeforeStartHours: readPositiveIntegerSetting(byKeyname, 'paymentDueBeforeStartHours'),
    processingMaxAttempts: readPositiveIntegerSetting(byKeyname, 'processingMaxAttempts'),
    selfServiceLockWindowHours: readPositiveIntegerSetting(byKeyname, 'selfServiceLockWindowHours'),
    publicEventCutoffAfterStartMinutes: readPositiveIntegerSetting(byKeyname, 'publicEventCutoffAfterStartMinutes'),
    slotLeadTimeHours: readPositiveIntegerSetting(byKeyname, 'slotLeadTimeHours'),
    eventLateAccessLinkExpiryHours: readPositiveIntegerSetting(byKeyname, 'eventLateAccessLinkExpiryHours'),
    adminManageTokenExpiryMinutes: readPositiveIntegerSetting(byKeyname, 'adminManageTokenExpiryMinutes'),
    sideEffectProcessingTimeoutMinutes: readPositiveIntegerSetting(byKeyname, 'sideEffectProcessingTimeoutMinutes'),
    paymentDueReminderLeadHours: readPositiveIntegerSetting(byKeyname, 'paymentDueReminderLeadHours'),
    paymentDueReminderSleepHoursStart: readPositiveIntegerSetting(byKeyname, 'paymentDueReminderSleepHoursStart'),
    paymentDueReminderSleepHoursEnd: readPositiveIntegerSetting(byKeyname, 'paymentDueReminderSleepHoursEnd'),
    paymentDueReminderFallbackHourPreviousDay: readPositiveIntegerSetting(byKeyname, 'paymentDueReminderFallbackHourPreviousDay'),
    paymentDueReminderFallbackHourNextMorning: readPositiveIntegerSetting(byKeyname, 'paymentDueReminderFallbackHourNextMorning'),
    eventReminderLeadHours: readPositiveIntegerSetting(byKeyname, 'eventReminderLeadHours'),
  });

  return applyOverrides(policy);
}

export async function getBookingPolicyConfig(
  repository: Pick<IRepository, 'listSystemSettings'>,
): Promise<BookingPolicyConfig> {
  return coerceBookingPolicyConfig(await repository.listSystemSettings());
}

export function applyBookingPolicyOverridesForTests(overrides: Partial<BookingPolicyConfig>): void {
  bookingPolicyOverridesForTests = {
    ...bookingPolicyOverridesForTests,
    ...overrides,
  };
}

export function resetBookingPolicyForTests(): void {
  bookingPolicyOverridesForTests = {};
}

export function describeBookingPolicyValidationError(
  error: unknown,
): { field: keyof BookingPolicyConfig | null; value: unknown } {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^booking_policy_config_invalid_(.+)$/.exec(message);
  if (!match) {
    return { field: null, value: null };
  }

  const field = match[1] as keyof BookingPolicyConfig;
  return {
    field,
    value: bookingPolicyOverridesForTests[field] ?? null,
  };
}

function formatHoursLabel(hours: number): string {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export function getBookingPolicyText(lockWindowHours: number): string {
  const lockWindowLabel = formatHoursLabel(lockWindowHours);
  return [
    'Booking policy',
    `You can reschedule or cancel your booking up to ${lockWindowLabel} before the session.`,
    `Within ${lockWindowLabel} of the session, bookings can no longer be changed online and are non-refundable.`,
    'If an emergency occurs, please contact me directly.',
  ].join('\n');
}
