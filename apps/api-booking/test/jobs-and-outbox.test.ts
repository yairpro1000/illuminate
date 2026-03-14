import { describe, expect, it, vi } from 'vitest';
import { runSideEffectsOutbox } from '../src/handlers/jobs.js';
import { MockRepository } from '../src/providers/repository/mock.js';

function makeCtx(overrides: any = {}) {
  const policyRepository = new MockRepository();
  const bookingRow = {
    id: 'b1',
    client_id: 'c1',
    event_id: null,
    session_type_id: 's1',
    booking_type: 'PAY_LATER',
    starts_at: '2026-04-10T10:00:00.000Z',
    ends_at: '2026-04-10T11:00:00.000Z',
    timezone: 'Europe/Zurich',
    google_event_id: 'g1',
    address_line: 'Somewhere 1, Zurich',
    maps_url: 'https://maps.example',
    current_status: 'CONFIRMED',
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
    deleteBookingSideEffect: vi.fn().mockResolvedValue(undefined),
    updateBookingSideEffect: vi.fn().mockResolvedValue(undefined),
    getLastBookingSideEffectAttempt: vi.fn().mockResolvedValue(null),
    createBookingSideEffectAttempt: vi.fn().mockResolvedValue(undefined),
    getBookingById: vi.fn().mockResolvedValue(bookingRow),
    getBookingEventById: vi.fn().mockResolvedValue({ payload: {} }),
    getPaymentByBookingId: vi.fn().mockResolvedValue({
      id: 'p1',
      booking_id: 'b1',
      provider: 'stripe',
      provider_payment_id: 'cs_test_123',
      amount_cents: 15000,
      currency: 'CHF',
      status: 'PENDING',
      checkout_url: 'https://checkout.local',
      invoice_url: null,
      raw_payload: null,
      paid_at: null,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    }),
    createPayment: vi.fn().mockResolvedValue({
      id: 'p1',
      booking_id: 'b1',
      provider: 'stripe',
      provider_payment_id: 'cs_test_123',
      amount_cents: 15000,
      currency: 'CHF',
      status: 'PENDING',
      checkout_url: 'https://checkout.local',
      invoice_url: null,
      raw_payload: null,
      paid_at: null,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    }),
    updatePayment: vi.fn().mockResolvedValue({
      id: 'p1',
      booking_id: 'b1',
      provider: 'stripe',
      provider_payment_id: 'cs_test_123',
      amount_cents: 15000,
      currency: 'CHF',
      status: 'PENDING',
      checkout_url: 'https://checkout.local',
      invoice_url: null,
      raw_payload: null,
      paid_at: null,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    }),
    createBookingEvent: vi.fn().mockResolvedValue({
      id: 'be_new',
      booking_id: 'b1',
      event_type: 'PAYMENT_SETTLED',
      source: 'SYSTEM',
      payload: {},
      created_at: '2026-03-01T00:00:00.000Z',
    }),
    createBookingSideEffects: vi.fn().mockResolvedValue([]),
    updateBooking: vi.fn().mockResolvedValue(bookingRow),
    getEventById: vi.fn().mockResolvedValue(null),
    listBookingEvents: vi.fn().mockResolvedValue([]),
    getLatestBookingEvent: vi.fn().mockResolvedValue(null),
    getAllSessionTypes: vi.fn().mockResolvedValue([
      {
        id: 's1',
        title: 'Session',
        slug: 'session',
        short_description: null,
        description: 'Session',
        duration_minutes: 60,
        price: 15000,
        currency: 'CHF',
        status: 'active',
        sort_order: 1,
        image_key: null,
        drive_file_id: null,
        image_alt: null,
        created_at: '2026-03-01T00:00:00.000Z',
        updated_at: '2026-03-01T00:00:00.000Z',
      },
    ]),
    listSystemSettings: vi.fn().mockImplementation(() => policyRepository.listSystemSettings()),
  };

  return {
    providers: {
      repository: {
        ...repository,
        ...((overrides.providers && overrides.providers.repository) || {}),
      },
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
        ...((overrides.providers && overrides.providers.email) || {}),
      },
      calendar: {
        createEvent: vi.fn().mockResolvedValue({ eventId: 'g1' }),
        updateEvent: vi.fn().mockResolvedValue(undefined),
        deleteEvent: vi.fn().mockResolvedValue(undefined),
        ...((overrides.providers && overrides.providers.calendar) || {}),
      },
      payments: {
        createCheckoutSession: vi.fn().mockResolvedValue({
          checkoutUrl: 'https://checkout.local',
          sessionId: 'cs_test_123',
          expiresAt: '2026-04-10T09:00:00.000Z',
        }),
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
}

describe('jobs and side-effect dispatcher', () => {
  it('records success attempt and marks payment reminder success', async () => {
    const effect = {
      id: 'se1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'SEND_PAYMENT_REMINDER',
      entity: 'EMAIL',
      status: 'FAILED',
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

    expect(ctx.providers.email.sendBookingPaymentReminder).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ booking_side_effect_id: 'se1', status: 'SUCCESS', attempt_num: 1 }),
    );
    expect(ctx.providers.repository.updateBookingSideEffect).toHaveBeenCalledWith(
      'se1',
      expect.objectContaining({ status: 'SUCCESS' }),
    );
  });

  it('discards irrelevant payment-link side effects once payment already settled', async () => {
    const effect = {
      id: 'se-link-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'SEND_PAYMENT_LINK',
      entity: 'EMAIL',
      status: 'PENDING',
      expires_at: '2026-03-01T00:00:00.000Z',
      max_attempts: 5,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    };
    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
          getPaymentByBookingId: vi.fn().mockResolvedValue({
            id: 'p1',
            booking_id: 'b1',
            provider: 'stripe',
            provider_payment_id: 'cs_test_123',
            amount_cents: 15000,
            currency: 'CHF',
            status: 'SUCCEEDED',
            checkout_url: 'https://checkout.local',
            invoice_url: null,
            raw_payload: null,
            paid_at: '2026-03-01T00:00:00.000Z',
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
          }),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.repository.deleteBookingSideEffect).toHaveBeenCalledWith('se-link-1');
    expect(ctx.providers.repository.createBookingSideEffectAttempt).not.toHaveBeenCalled();
  });

  it('dispatches stale recovered booking confirmation effects', async () => {
    const effect = {
      id: 'se-confirm-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'SEND_BOOKING_CONFIRMATION',
      entity: 'EMAIL',
      status: 'PENDING',
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

    expect(ctx.providers.email.sendBookingConfirmation).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ booking_side_effect_id: 'se-confirm-1', status: 'SUCCESS' }),
    );
  });

  it('keeps booking confirmation retryable when session invite is still missing', async () => {
    const effect = {
      id: 'se-confirm-missing-cal-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'SEND_BOOKING_CONFIRMATION',
      entity: 'EMAIL',
      status: 'PENDING',
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
            booking_type: 'PAY_LATER',
            starts_at: '2026-04-10T10:00:00.000Z',
            ends_at: '2026-04-10T11:00:00.000Z',
            timezone: 'Europe/Zurich',
            google_event_id: null,
            address_line: 'Somewhere 1, Zurich',
            maps_url: 'https://maps.example',
            current_status: 'CONFIRMED',
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

    expect(ctx.providers.email.sendBookingConfirmation).not.toHaveBeenCalled();
    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        booking_side_effect_id: 'se-confirm-missing-cal-1',
        status: 'FAILED',
        error_message: expect.stringContaining('session_calendar_invite_missing_before_confirmation_email'),
      }),
    );
  });
});
