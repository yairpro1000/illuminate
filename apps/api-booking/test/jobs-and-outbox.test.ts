import { describe, it, expect, vi } from 'vitest';
import { runCron, runSideEffectsOutbox } from '../src/handlers/jobs.js';

function makeCtx(overrides: any = {}) {
  const repository = {
    markStaleProcessingSideEffectsAsPending: vi.fn().mockResolvedValue(0),
    getPendingBookingSideEffects: vi.fn().mockResolvedValue([]),
    updateBookingSideEffect: vi.fn().mockResolvedValue(undefined),
    getLastBookingSideEffectAttempt: vi.fn().mockResolvedValue(null),
    createBookingSideEffectAttempt: vi.fn().mockResolvedValue(undefined),
    getBookingById: vi.fn().mockResolvedValue({ id: 'b1', event_id: null, current_status: 'SLOT_CONFIRMED' }),
    getBookingEventById: vi.fn().mockResolvedValue({ payload: {} }),
    getPaymentByBookingId: vi.fn().mockResolvedValue({ checkout_url: 'https://checkout.local' }),
    createBookingEvent: vi.fn().mockResolvedValue(undefined),
    updateBooking: vi.fn().mockResolvedValue(undefined),
    logFailure: vi.fn().mockResolvedValue(undefined),
    getEventById: vi.fn().mockResolvedValue(null),
    listBookingEvents: vi.fn().mockResolvedValue([]),
    getCalendarSyncFailuresDue: vi.fn().mockResolvedValue([]),
    resolveCalendarSyncFailure: vi.fn().mockResolvedValue(undefined),
    recordCalendarSyncFailure: vi.fn().mockResolvedValue(undefined),
  };

  const providers = {
    repository,
    email: {
      sendBookingPaymentReminder: vi.fn().mockResolvedValue(undefined),
      sendBookingCancellation: vi.fn().mockResolvedValue(undefined),
      sendBookingConfirmRequest: vi.fn().mockResolvedValue(undefined),
      sendEventConfirmRequest: vi.fn().mockResolvedValue(undefined),
      sendBookingPaymentDue: vi.fn().mockResolvedValue(undefined),
      sendEventFollowup: vi.fn().mockResolvedValue(undefined),
      sendBookingReminder24h: vi.fn().mockResolvedValue(undefined),
      sendEventReminder24h: vi.fn().mockResolvedValue(undefined),
    },
    calendar: {
      createEvent: vi.fn().mockResolvedValue({ eventId: 'g1' }),
      updateEvent: vi.fn().mockResolvedValue(undefined),
      deleteEvent: vi.fn().mockResolvedValue(undefined),
    },
  };

  const ctx = {
    providers: {
      ...providers,
      ...(overrides.providers || {}),
      repository: {
        ...repository,
        ...((overrides.providers && overrides.providers.repository) || {}),
      },
    },
    env: { SITE_URL: 'https://example.com' },
    logger: {
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    requestId: 'req',
    triggerSource: 'manual',
  } as any;

  return ctx;
}

describe('Jobs and side-effect dispatcher', () => {
  it('records success attempt and marks side effect success', async () => {
    const effect = {
      id: 'se1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'send_payment_reminder',
      entity: 'email',
      status: 'pending',
      expires_at: null,
      max_attempts: 5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ booking_side_effect_id: 'se1', status: 'success', attempt_num: 1 }),
    );
    expect(ctx.providers.repository.updateBookingSideEffect).toHaveBeenCalledWith(
      'se1',
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('marks side effect dead when max attempts is reached', async () => {
    const effect = {
      id: 'se2',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'send_payment_reminder',
      entity: 'email',
      status: 'pending',
      expires_at: null,
      max_attempts: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
          getLastBookingSideEffectAttempt: vi.fn().mockResolvedValue({ attempt_num: 1 }),
        },
        email: {
          sendBookingPaymentReminder: vi.fn().mockRejectedValue(new Error('smtp down')),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ booking_side_effect_id: 'se2', status: 'fail', attempt_num: 2 }),
    );
    expect(ctx.providers.repository.updateBookingSideEffect).toHaveBeenCalledWith(
      'se2',
      expect.objectContaining({ status: 'dead' }),
    );
    expect(ctx.providers.repository.logFailure).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'side-effects-dispatcher', booking_id: 'b1' }),
    );
  });

  it('runs unified cron sweep for supported expression', async () => {
    const ctx = makeCtx();
    await expect(runCron('* * * * *', ctx)).resolves.toBeUndefined();

    expect(ctx.providers.repository.getPendingBookingSideEffects).toHaveBeenCalled();
    expect(ctx.providers.repository.getCalendarSyncFailuresDue).toHaveBeenCalledWith(100);
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'cron_dispatch_decision',
        context: expect.objectContaining({ branch_taken: 'run_unified_sweep_known_expression' }),
      }),
    );
  });

  it('logs fallback branch for unknown cron expression', async () => {
    const ctx = makeCtx();
    await expect(runCron('*/10 * * * *', ctx)).resolves.toBeUndefined();

    expect(ctx.logger.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'cron_dispatch_fallback',
        context: expect.objectContaining({ fallback_reason: 'unknown_cron_expression' }),
      }),
    );
  });
});
