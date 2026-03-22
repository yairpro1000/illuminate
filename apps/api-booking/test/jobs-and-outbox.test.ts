import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSideEffectsOutbox } from '../src/handlers/jobs.js';
import { MockRepository } from '../src/providers/repository/mock.js';
import { RetryableCalendarWriteError } from '../src/providers/calendar/interface.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCtx(overrides: any = {}) {
  const policyRepository = new MockRepository();
  const basePayment = {
    id: 'p1',
    booking_id: 'b1',
    provider: 'stripe',
    amount: 150,
    currency: 'CHF',
    status: 'PENDING',
    checkout_url: 'https://checkout.local',
    invoice_url: null,
    raw_payload: null,
    paid_at: null,
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
    stripe_customer_id: 'cus_test_123',
    stripe_checkout_session_id: 'cs_test_123',
    stripe_payment_intent_id: null,
    stripe_invoice_id: null,
    stripe_payment_link_id: null,
  };
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
    updateBookingEvent: vi.fn().mockImplementation(async (id, updates) => ({
      id,
      booking_id: 'b1',
      event_type: 'REFUND_COMPLETED',
      source: 'SYSTEM',
      status: 'SUCCESS',
      payload: {},
      error_message: null,
      completed_at: '2026-03-01T00:00:00.000Z',
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
      ...updates,
    })),
    getLastBookingSideEffectAttempt: vi.fn().mockResolvedValue(null),
    createBookingSideEffectAttempt: vi.fn().mockResolvedValue({
      id: 'attempt-1',
      booking_side_effect_id: 'se1',
      attempt_num: 1,
      api_log_id: null,
      status: 'PROCESSING',
      error_message: null,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
      completed_at: null,
    }),
    updateBookingSideEffectAttempt: vi.fn().mockResolvedValue(undefined),
    getBookingById: vi.fn().mockResolvedValue(bookingRow),
    getBookingEventById: vi.fn().mockResolvedValue({
      id: 'be1',
      booking_id: 'b1',
      event_type: 'BOOKING_FORM_SUBMITTED',
      source: 'PUBLIC_UI',
      status: 'PENDING',
      payload: {},
      error_message: null,
      completed_at: null,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    }),
    getPaymentByBookingId: vi.fn().mockResolvedValue({
      ...basePayment,
    }),
    createPayment: vi.fn().mockResolvedValue({
      ...basePayment,
    }),
    updatePayment: vi.fn().mockImplementation(async (_id, updates) => ({
      ...basePayment,
      ...updates,
      updated_at: '2026-03-01T00:00:00.000Z',
    })),
    createBookingEvent: vi.fn().mockResolvedValue({
      id: 'be_new',
      booking_id: 'b1',
      event_type: 'PAYMENT_SETTLED',
      source: 'SYSTEM',
      status: 'PENDING',
      payload: {},
      error_message: null,
      completed_at: null,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    }),
    createBookingSideEffects: vi.fn().mockResolvedValue([]),
    listBookingSideEffectsForEvent: vi.fn().mockResolvedValue([]),
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
        price: 150,
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
        sendEventCancellation: vi.fn().mockResolvedValue(undefined),
        sendBookingExpired: vi.fn().mockResolvedValue(undefined),
        sendBookingConfirmRequest: vi.fn().mockResolvedValue(undefined),
        sendEventConfirmRequest: vi.fn().mockResolvedValue(undefined),
        sendBookingPaymentDue: vi.fn().mockResolvedValue(undefined),
        sendEventFollowup: vi.fn().mockResolvedValue(undefined),
        sendBookingReminder24h: vi.fn().mockResolvedValue(undefined),
        sendEventReminder24h: vi.fn().mockResolvedValue(undefined),
        sendBookingConfirmation: vi.fn().mockResolvedValue(undefined),
        sendEventConfirmation: vi.fn().mockResolvedValue(undefined),
        sendRefundConfirmation: vi.fn().mockResolvedValue(undefined),
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
        createRefund: vi.fn().mockResolvedValue({
          refundPath: 'credit_note',
          refundStatus: 'SUCCEEDED',
          refundId: 're_test_123',
          creditNoteId: 'cn_test_123',
          creditNoteNumber: 'CN-TEST-123',
          creditNoteDocumentUrl: 'https://example.com/credit-note/cn_test_123',
          receiptUrl: 'https://example.com/receipt/re_test_123',
          invoiceId: 'in_test_123',
          paymentIntentId: 'pi_test_123',
          amount: 150,
          currency: 'CHF',
        }),
        ...((overrides.providers && overrides.providers.payments) || {}),
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
      expect.objectContaining({ booking_side_effect_id: 'se1', status: 'PROCESSING', attempt_num: 1 }),
    );
    expect(ctx.providers.repository.updateBookingSideEffectAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ status: 'SUCCESS' }),
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
            amount: 150,
            currency: 'CHF',
            status: 'SUCCEEDED',
            checkout_url: 'https://checkout.local',
            invoice_url: null,
            raw_payload: null,
            paid_at: '2026-03-01T00:00:00.000Z',
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
            stripe_customer_id: 'cus_test_123',
            stripe_checkout_session_id: 'cs_test_123',
            stripe_payment_intent_id: 'pi_test_123',
            stripe_invoice_id: null,
            stripe_payment_link_id: null,
          }),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.repository.deleteBookingSideEffect).toHaveBeenCalledWith('se-link-1');
    expect(ctx.providers.repository.createBookingSideEffectAttempt).not.toHaveBeenCalled();
  });

  it('discards payment reminders once payment has failed but still lets expiry logic own the booking', async () => {
    const effect = {
      id: 'se-reminder-failed-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'SEND_PAYMENT_REMINDER',
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
            amount: 150,
            currency: 'CHF',
            status: 'FAILED',
            checkout_url: 'https://checkout.local',
            invoice_url: null,
            raw_payload: null,
            paid_at: null,
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
            stripe_customer_id: 'cus_test_123',
            stripe_checkout_session_id: 'cs_failed_123',
            stripe_payment_intent_id: 'pi_failed_123',
            stripe_invoice_id: null,
            stripe_payment_link_id: null,
          }),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.email.sendBookingPaymentReminder).not.toHaveBeenCalled();
    expect(ctx.providers.repository.deleteBookingSideEffect).toHaveBeenCalledWith('se-reminder-failed-1');
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
      expect.objectContaining({ booking_side_effect_id: 'se-confirm-1', status: 'PROCESSING' }),
    );
    expect(ctx.providers.repository.updateBookingSideEffectAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ status: 'SUCCESS' }),
    );
  });

  it('dispatches stale recovered refund creation effects through the shared refund path', async () => {
    const effect = {
      id: 'se-refund-create-1',
      booking_id: 'b1',
      booking_event_id: 'be-refund-create-1',
      effect_intent: 'CREATE_STRIPE_REFUND',
      entity: 'PAYMENT',
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
          listBookingEvents: vi.fn().mockResolvedValue([]),
          getPaymentByBookingId: vi.fn().mockResolvedValue({
            id: 'p1',
            booking_id: 'b1',
            provider: 'stripe',
            amount: 150,
            currency: 'CHF',
            status: 'SUCCEEDED',
            checkout_url: 'https://checkout.local',
            invoice_url: 'https://example.com/invoice/in_123',
            raw_payload: null,
            paid_at: '2026-03-01T00:00:00.000Z',
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
            stripe_customer_id: 'cus_test_123',
            stripe_checkout_session_id: 'cs_test_123',
            stripe_payment_intent_id: 'pi_test_123',
            stripe_invoice_id: 'in_123',
            stripe_payment_link_id: null,
            refund_status: 'NONE',
            refund_amount: null,
            refund_currency: null,
            stripe_refund_id: null,
            stripe_credit_note_id: null,
            stripe_receipt_url: null,
            stripe_credit_note_url: null,
            refunded_at: null,
            refund_reason: null,
          }),
        },
        payments: {
          createRefund: vi.fn().mockResolvedValue({
            refundPath: 'credit_note',
            refundStatus: 'SUCCEEDED',
            refundId: 're_123',
            creditNoteId: 'cn_123',
            creditNoteNumber: 'CN-123',
            creditNoteDocumentUrl: 'https://example.com/credit-note/cn_123',
            receiptUrl: 'https://example.com/receipt/re_123',
            invoiceId: 'in_123',
            paymentIntentId: 'pi_test_123',
            amount: 150,
            currency: 'CHF',
          }),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.payments.createRefund).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ booking_side_effect_id: 'se-refund-create-1', status: 'PROCESSING' }),
    );
    expect(ctx.providers.repository.updateBookingSideEffectAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ status: 'SUCCESS' }),
    );
  });

  it('dispatches stale recovered refund email effects through the shared refund email path', async () => {
    const effect = {
      id: 'se-refund-email-1',
      booking_id: 'b1',
      booking_event_id: 'be-refund-email-1',
      effect_intent: 'SEND_BOOKING_REFUND_CONFIRMATION',
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
            session_type_title: 'Refundable Session',
            booking_type: 'PAY_LATER',
            starts_at: '2026-04-10T10:00:00.000Z',
            ends_at: '2026-04-10T11:00:00.000Z',
            timezone: 'Europe/Zurich',
            google_event_id: 'g1',
            address_line: 'Somewhere 1, Zurich',
            maps_url: 'https://maps.example',
            current_status: 'CANCELED',
            notes: null,
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
            client_first_name: 'Test',
            client_last_name: 'User',
            client_email: 'test@example.com',
            client_phone: '+41000000000',
          }),
          getBookingEventById: vi.fn().mockResolvedValue({
            id: 'be-refund-email-1',
            payload: {
              refund_path: 'credit_note',
              refund_amount: 150,
              refund_currency: 'CHF',
              invoice_id: 'in_123',
              stripe_refund_id: 're_123',
              stripe_credit_note_id: 'cn_123',
              credit_note_number: 'CN-123',
              credit_note_url: 'https://example.com/credit-note/cn_123',
              receipt_url: 'https://example.com/receipt/re_123',
            },
          }),
          getPaymentByBookingId: vi.fn().mockResolvedValue({
            id: 'p1',
            booking_id: 'b1',
            provider: 'stripe',
            amount: 150,
            currency: 'CHF',
            status: 'REFUNDED',
            checkout_url: 'https://checkout.local',
            invoice_url: 'https://example.com/invoice/in_123',
            raw_payload: null,
            paid_at: '2026-03-01T00:00:00.000Z',
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
            stripe_customer_id: 'cus_test_123',
            stripe_checkout_session_id: 'cs_test_123',
            stripe_payment_intent_id: 'pi_test_123',
            stripe_invoice_id: 'in_123',
            stripe_payment_link_id: null,
            refund_status: 'SUCCEEDED',
            refund_amount: 150,
            refund_currency: 'CHF',
            stripe_refund_id: 're_123',
            stripe_credit_note_id: 'cn_123',
            stripe_receipt_url: 'https://example.com/receipt/re_123',
            stripe_credit_note_url: 'https://example.com/credit-note/cn_123',
            refunded_at: '2026-03-02T00:00:00.000Z',
            refund_reason: 'Client canceled in refundable window.',
          }),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.email.sendRefundConfirmation).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ booking_side_effect_id: 'se-refund-email-1', status: 'PROCESSING' }),
    );
    expect(ctx.providers.repository.updateBookingSideEffectAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ status: 'SUCCESS' }),
    );
  });

  it('waits until a failed calendar retry reaches its scheduled expires_at', async () => {
    const effect = {
      id: 'se-calendar-wait-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'RESERVE_CALENDAR_SLOT',
      entity: 'CALENDAR',
      status: 'FAILED',
      expires_at: '2099-03-01T00:00:00.000Z',
      max_attempts: 5,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    };
    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.calendar.createEvent).not.toHaveBeenCalled();
    expect(ctx.providers.repository.updateBookingSideEffect).not.toHaveBeenCalledWith(
      'se-calendar-wait-1',
      expect.objectContaining({ status: 'PROCESSING' }),
    );
    expect(ctx.providers.repository.createBookingSideEffectAttempt).not.toHaveBeenCalled();
  });

  it('schedules retryable calendar failures with backoff and logs calendar_retry metadata', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const effect = {
      id: 'se-calendar-retry-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'RESERVE_CALENDAR_SLOT',
      entity: 'CALENDAR',
      status: 'FAILED',
      expires_at: null,
      max_attempts: 5,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    };
    const ctx = makeCtx({
      providers: {
        repository: {
          getPendingBookingSideEffects: vi.fn().mockResolvedValue([effect]),
          getLastBookingSideEffectAttempt: vi.fn().mockResolvedValue({ attempt_num: 1 }),
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
        },
        calendar: {
          createEvent: vi.fn().mockRejectedValue(
            new RetryableCalendarWriteError(
              'Google createEvent failed (403): quotaExceeded',
              { statusCode: 403, reason: 'quotaExceeded' },
            ),
          ),
        },
      },
    });

    await expect(runSideEffectsOutbox(ctx)).resolves.toBeUndefined();

    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ booking_side_effect_id: 'se-calendar-retry-1', status: 'PROCESSING', attempt_num: 2 }),
    );
    expect(ctx.providers.repository.updateBookingSideEffectAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ status: 'FAILED' }),
    );
    expect(ctx.providers.repository.updateBookingSideEffect).toHaveBeenCalledWith(
      'se-calendar-retry-1',
      expect.objectContaining({ status: 'FAILED', expires_at: expect.any(String) }),
    );
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'calendar_retry',
      context: expect.objectContaining({
        booking_id: 'b1',
        attempt: 2,
        delay_ms: 15_000,
        reason: 'Google createEvent failed (403): quotaExceeded',
        request_id: 'req',
      }),
    }));
  });

  it('dispatches booking expiry notifications through the dedicated expired email path', async () => {
    const effect = {
      id: 'se-expired-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'SEND_BOOKING_EXPIRATION_NOTIFICATION',
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

    expect(ctx.providers.email.sendBookingExpired).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b1' }),
      'https://example.com/sessions.html',
    );
    expect(ctx.providers.email.sendBookingCancellation).not.toHaveBeenCalled();
    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ booking_side_effect_id: 'se-expired-1', status: 'PROCESSING' }),
    );
    expect(ctx.providers.repository.updateBookingSideEffectAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ status: 'SUCCESS' }),
    );
  });

  it('sends pay-later confirmation even when the calendar invite is still missing', async () => {
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

    expect(ctx.providers.email.sendBookingConfirmation).toHaveBeenCalledTimes(1);
    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        booking_side_effect_id: 'se-confirm-missing-cal-1',
        status: 'PROCESSING',
      }),
    );
    expect(ctx.providers.repository.updateBookingSideEffectAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ status: 'SUCCESS' }),
    );
  });

  it('dispatches event cancellation through the shared event path with the loaded event title', async () => {
    const effect = {
      id: 'se-cancel-event-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'SEND_BOOKING_CANCELLATION_CONFIRMATION',
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
            event_id: 'evt-1',
            current_status: 'CANCELLED',
            client_email: 'maya@example.com',
          }),
          getEventById: vi.fn().mockResolvedValue({
            id: 'evt-1',
            title: 'Listening to the Body',
          }),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.email.sendEventCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b1', event_id: 'evt-1' }),
      expect.objectContaining({ id: 'evt-1', title: 'Listening to the Body' }),
      'https://example.com/evenings.html',
      expect.objectContaining({ includeRefundNotice: false }),
    );
    expect(ctx.providers.email.sendBookingCancellation).not.toHaveBeenCalled();
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_cancellation_email_dispatch_completed',
      context: expect.objectContaining({
        branch_taken: 'event_cancellation_email_sent',
        event_id: 'evt-1',
      }),
    }));
  });

  it('logs and records a failed attempt when an event cancellation cannot load its event', async () => {
    const effect = {
      id: 'se-cancel-event-missing-1',
      booking_id: 'b1',
      booking_event_id: 'be1',
      effect_intent: 'SEND_BOOKING_CANCELLATION_CONFIRMATION',
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
            event_id: 'evt-missing',
            current_status: 'CANCELLED',
            client_email: 'maya@example.com',
          }),
          getEventById: vi.fn().mockResolvedValue(null),
        },
      },
    });

    await runSideEffectsOutbox(ctx);

    expect(ctx.providers.email.sendEventCancellation).not.toHaveBeenCalled();
    expect(ctx.providers.repository.createBookingSideEffectAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        booking_side_effect_id: 'se-cancel-event-missing-1',
        status: 'PROCESSING',
      }),
    );
    expect(ctx.providers.repository.updateBookingSideEffectAttempt).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        status: 'FAILED',
        error_message: 'event_not_found_for_cancellation_email',
      }),
    );
    expect(ctx.logger.logError).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_cancellation_email_dispatch_failed',
      context: expect.objectContaining({
        branch_taken: 'deny_event_cancellation_event_missing',
        deny_reason: 'event_not_found_for_cancellation_email',
        event_id: 'evt-missing',
      }),
    }));
  });
});
