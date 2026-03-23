import { describe, expect, it, vi } from 'vitest';
import { finalizeBookingEventStatus } from '../src/services/booking-event-workflow.js';

const BOOKING_POLICY_SETTINGS = [
  ['nonPaidConfirmationWindowMinutes', '60'],
  ['payNowCheckoutWindowMinutes', '60'],
  ['payNowReminderGraceMinutes', '30'],
  ['paymentDueBeforeStartHours', '24'],
  ['processingMaxAttempts', '5'],
  ['selfServiceLockWindowHours', '24'],
  ['publicEventCutoffAfterStartMinutes', '60'],
  ['slotLeadTimeHours', '12'],
  ['eventLateAccessLinkExpiryHours', '24'],
  ['adminManageTokenExpiryMinutes', '60'],
  ['sideEffectProcessingTimeoutMinutes', '10'],
  ['paymentDueReminderLeadHours', '6'],
  ['paymentDueReminderSleepHoursStart', '22'],
  ['paymentDueReminderSleepHoursEnd', '7'],
  ['paymentDueReminderFallbackHourPreviousDay', '18'],
  ['paymentDueReminderFallbackHourNextMorning', '9'],
  ['eventReminderLeadHours', '24'],
].map(([keyname, value]) => ({
  domain: 'booking',
  keyname,
  readable_name: keyname,
  value_type: 'integer',
  unit: null,
  value,
  description: keyname,
  description_he: null,
  created_at: '2026-03-23T00:00:00.000Z',
  updated_at: '2026-03-23T00:00:00.000Z',
}));

function makeCtx(overrides: Record<string, unknown> = {}) {
  const repository = {
    getBookingEventById: vi.fn().mockResolvedValue({
      id: 'be1',
      booking_id: 'b1',
      event_type: 'BOOKING_FORM_SUBMITTED',
      source: 'PUBLIC_UI',
      status: 'PROCESSING',
      payload: {},
      error_message: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    listBookingSideEffectsForEvent: vi.fn().mockResolvedValue([
      {
        id: 'se1',
        booking_event_id: 'be1',
        entity: 'EMAIL',
        effect_intent: 'SEND_BOOKING_CONFIRMATION',
        status: 'PROCESSING',
        expires_at: null,
        max_attempts: 5,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]),
    getLastBookingSideEffectAttempt: vi.fn().mockResolvedValue({
      id: 'attempt-1',
      booking_side_effect_id: 'se1',
      attempt_num: 1,
      api_log_id: null,
      status: 'SUCCESS',
      error_message: null,
      created_at: '2026-03-23T00:00:00.000Z',
      updated_at: '2026-03-23T00:00:00.000Z',
      completed_at: '2026-03-23T00:00:01.000Z',
    }),
    listSystemSettings: vi.fn().mockResolvedValue(BOOKING_POLICY_SETTINGS),
    updateBookingSideEffect: vi.fn().mockResolvedValue(undefined),
    updateBookingEvent: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      id: 'be1',
      booking_id: 'b1',
      event_type: 'BOOKING_FORM_SUBMITTED',
      source: 'PUBLIC_UI',
      status: patch.status ?? 'PROCESSING',
      payload: {},
      error_message: patch.error_message ?? null,
      completed_at: patch.completed_at ?? null,
      created_at: '2026-03-23T00:00:00.000Z',
      updated_at: String(patch.updated_at ?? '2026-03-23T00:00:00.000Z'),
    })),
    ...overrides,
  };

  return {
    providers: { repository },
    logger: {
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      captureException: vi.fn(),
    },
  } as any;
}

describe('booking event workflow finalization', () => {
  it('does not reconcile processing side effects during realtime finalization unless explicitly requested', async () => {
    const ctx = makeCtx();
    const event = {
      id: 'be1',
      booking_id: 'b1',
      event_type: 'BOOKING_FORM_SUBMITTED',
      source: 'PUBLIC_UI',
      status: 'PROCESSING',
      payload: {},
      error_message: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await finalizeBookingEventStatus('be1', ctx, {
      event,
      startedExecution: true,
    });

    expect(ctx.providers.repository.getBookingEventById).not.toHaveBeenCalled();
    expect(ctx.providers.repository.getLastBookingSideEffectAttempt).not.toHaveBeenCalled();
    expect(ctx.providers.repository.updateBookingSideEffect).not.toHaveBeenCalled();
    expect(ctx.providers.repository.updateBookingEvent).toHaveBeenCalledWith(
      'be1',
      expect.objectContaining({
        status: 'PROCESSING',
      }),
    );
  });

  it('reconciles processing side effects only when explicitly requested', async () => {
    const ctx = makeCtx();

    await finalizeBookingEventStatus('be1', ctx, {
      startedExecution: false,
      reconcileProcessing: true,
    });

    expect(ctx.providers.repository.getLastBookingSideEffectAttempt).toHaveBeenCalledWith('se1');
    expect(ctx.providers.repository.updateBookingSideEffect).toHaveBeenCalledWith(
      'se1',
      expect.objectContaining({
        status: 'SUCCESS',
      }),
    );
  });
});
