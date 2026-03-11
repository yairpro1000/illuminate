import { describe, it, expect, vi } from 'vitest';
import { runCron, runSideEffectsOutbox } from '../src/handlers/jobs.js';

function makeCtx(overrides: any = {}) {
  const bookingRow = {
    id: 'b1',
    client_id: 'c1',
    event_id: null,
    session_type_id: 's1',
    starts_at: '2026-04-10T10:00:00.000Z',
    ends_at: '2026-04-10T11:00:00.000Z',
    timezone: 'Europe/Zurich',
    google_event_id: null,
    address_line: 'Somewhere 1, Zurich',
    maps_url: 'https://maps.example',
    current_status: 'SLOT_CONFIRMED',
    notes: null,
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
    client_first_name: 'Test',
    client_last_name: 'User',
    client_email: 'test@example.com',
    client_phone: '+41000000000',
  };

  const repository = {
    markStaleProcessingSideEffectsAsPending: vi.fn().mockResolvedValue(0),
    getPendingBookingSideEffects: vi.fn().mockResolvedValue([]),
    updateBookingSideEffect: vi.fn().mockResolvedValue(undefined),
    getLastBookingSideEffectAttempt: vi.fn().mockResolvedValue(null),
    createBookingSideEffectAttempt: vi.fn().mockResolvedValue(undefined),
    getBookingById: vi.fn().mockResolvedValue(bookingRow),
    getBookingEventById: vi.fn().mockResolvedValue({ payload: {} }),
    getPaymentByBookingId: vi.fn().mockResolvedValue({ checkout_url: 'https://checkout.local' }),
    createBookingEvent: vi.fn().mockResolvedValue({
      id: 'be_new',
      booking_id: 'b1',
      event_type: 'SLOT_CONFIRMED',
      source: 'job',
      payload: {},
      created_at: '2026-03-01T00:00:00.000Z',
    }),
    createBookingSideEffects: vi.fn().mockResolvedValue([]),
    updateBooking: vi.fn().mockResolvedValue({
      ...bookingRow,
      google_event_id: 'g1',
    }),
    getEventById: vi.fn().mockResolvedValue(null),
    listBookingEvents: vi.fn().mockResolvedValue([]),
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
      sendBookingConfirmation: vi.fn().mockResolvedValue(undefined),
      sendEventConfirmation: vi.fn().mockResolvedValue(undefined),
      sendContactMessage: vi.fn().mockResolvedValue(undefined),
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
    expect(ctx.logger.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'side_effect_dispatch_failure',
        context: expect.objectContaining({ job_name: 'side-effects-dispatcher', booking_id: 'b1' }),
      }),
    );
  });

  it('runs unified cron sweep for supported expression', async () => {
    const ctx = makeCtx();
    await expect(runCron('* * * * *', ctx)).resolves.toBeUndefined();

    expect(ctx.providers.repository.getPendingBookingSideEffects).toHaveBeenCalled();
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

  it('appends SLOT_CONFIRMED after successful reserve_slot side effect execution when missing', async () => {
    const effect = {
      id: 'se-reserve-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'reserve_slot',
      entity: 'calendar',
      status: 'failed',
      expires_at: null,
      max_attempts: 5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
          listBookingEvents: vi
            .fn()
            .mockResolvedValueOnce([
              {
                id: 'be_submit',
                booking_id: 'b1',
                event_type: 'BOOKING_FORM_SUBMITTED_PAY_LATER',
                source: 'public_ui',
                payload: {},
                created_at: '2026-03-01T00:00:00.000Z',
              },
              {
                id: 'be_confirm',
                booking_id: 'b1',
                event_type: 'EMAIL_CONFIRMED',
                source: 'public_ui',
                payload: {},
                created_at: '2026-03-01T00:01:00.000Z',
              },
            ])
            .mockResolvedValue([]),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.repository.createBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        booking_id: 'b1',
        event_type: 'SLOT_CONFIRMED',
        source: 'job',
      }),
    );
    const appendedLogExists = ctx.logger.logInfo.mock.calls.some(([entry]: [any]) =>
      entry?.eventType === 'calendar_retry_slot_confirmed_appended' &&
      entry?.context?.booking_id === 'b1' &&
      entry?.context?.trigger === 'reserve_slot_effect' &&
      entry?.context?.branch_taken === 'slot_confirmed_appended_after_retry',
    );
    expect(appendedLogExists).toBe(true);
  });

  it('skips first-attempt non-cron pending side effects in sweeper', async () => {
    const nowIso = new Date().toISOString();
    const effect = {
      id: 'se-non-cron-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'cancel_reserved_slot',
      entity: 'calendar',
      status: 'pending',
      expires_at: null,
      max_attempts: 5,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.calendar.deleteEvent).not.toHaveBeenCalled();
    const decisionLogExists = ctx.logger.logInfo.mock.calls.some(([entry]: [any]) =>
      entry?.eventType === 'side_effect_sweeper_dispatch_decision' &&
      entry?.context?.side_effect_id === 'se-non-cron-1' &&
      entry?.context?.branch_taken === 'skip_pending_non_cron_first_attempt' &&
      entry?.context?.deny_reason === 'non_cron_side_effect_must_execute_realtime',
    );
    expect(decisionLogExists).toBe(true);
  });

  it('dispatches stale-recovered pending non-cron side effects', async () => {
    const effect = {
      id: 'se-stale-non-cron-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'send_booking_cancellation_confirmation',
      entity: 'email',
      status: 'pending',
      expires_at: null,
      max_attempts: 5,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:20:00.000Z',
    };

    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.email.sendBookingCancellation).toHaveBeenCalled();
    const decisionLogExists = ctx.logger.logInfo.mock.calls.some(([entry]: [any]) =>
      entry?.eventType === 'side_effect_sweeper_dispatch_decision' &&
      entry?.context?.side_effect_id === 'se-stale-non-cron-1' &&
      entry?.context?.branch_taken === 'dispatch_stale_recovered_pending_effect',
    );
    expect(decisionLogExists).toBe(true);
  });

  it('dispatches stale-recovered booking confirmation side effects', async () => {
    const effect = {
      id: 'se-booking-confirm-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'send_booking_confirmation',
      entity: 'email',
      status: 'pending',
      expires_at: null,
      max_attempts: 5,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:20:00.000Z',
    };

    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
          getBookingById: vi.fn().mockResolvedValue({
            id: 'b1',
            client_id: 'c1',
            event_id: null,
            session_type_id: 's1',
            starts_at: '2026-04-10T10:00:00.000Z',
            ends_at: '2026-04-10T11:00:00.000Z',
            timezone: 'Europe/Zurich',
            google_event_id: 'g1',
            address_line: 'Somewhere 1, Zurich',
            maps_url: 'https://maps.example',
            current_status: 'SLOT_CONFIRMED',
            notes: null,
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
            client_first_name: 'Test',
            client_last_name: 'User',
            client_email: 'test@example.com',
            client_phone: '+41000000000',
          }),
          getPaymentByBookingId: vi.fn().mockResolvedValue(null),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.email.sendBookingConfirmation).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ booking_side_effect_id: 'se-booking-confirm-1', status: 'success', attempt_num: 1 }),
    );
  });

  it('keeps session confirmation side effects retryable when calendar invite is missing', async () => {
    const effect = {
      id: 'se-booking-confirm-missing-cal-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'send_booking_confirmation',
      entity: 'email',
      status: 'pending',
      expires_at: null,
      max_attempts: 5,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:20:00.000Z',
    };

    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
          getPaymentByBookingId: vi.fn().mockResolvedValue(null),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.email.sendBookingConfirmation).not.toHaveBeenCalled();
    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        booking_side_effect_id: 'se-booking-confirm-missing-cal-1',
        status: 'fail',
        attempt_num: 1,
        error_message: expect.stringContaining('session_calendar_invite_missing_before_confirmation_email'),
      }),
    );
    expect(ctx.providers.repository.updateBookingSideEffect).toHaveBeenCalledWith(
      'se-booking-confirm-missing-cal-1',
      expect.objectContaining({ status: 'failed' }),
    );
    const denyLogExists = ctx.logger.logInfo.mock.calls.some(([entry]: [any]) =>
      entry?.eventType === 'booking_confirmation_email_dispatch_decision' &&
      entry?.context?.booking_id === 'b1' &&
      entry?.context?.branch_taken === 'deny_session_confirmation_until_calendar_synced' &&
      entry?.context?.deny_reason === 'session_calendar_invite_missing_before_confirmation_email',
    );
    expect(denyLogExists).toBe(true);
  });

  it('does not first-run create_stripe_checkout in sweeper', async () => {
    const nowIso = new Date().toISOString();
    const effect = {
      id: 'se-stripe-checkout-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'create_stripe_checkout',
      entity: 'payment',
      status: 'pending',
      expires_at: null,
      max_attempts: 5,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.repository.createBookingSideEffectAttempt).not.toHaveBeenCalled();
    const decisionLogExists = ctx.logger.logInfo.mock.calls.some(([entry]: [any]) =>
      entry?.eventType === 'side_effect_sweeper_dispatch_decision' &&
      entry?.context?.side_effect_id === 'se-stripe-checkout-1' &&
      entry?.context?.side_effect_intent === 'create_stripe_checkout' &&
      entry?.context?.branch_taken === 'skip_pending_non_cron_first_attempt',
    );
    expect(decisionLogExists).toBe(true);
  });
});
