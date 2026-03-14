import { describe, expect, it, vi } from 'vitest';
import { handleAdminSettleBookingPayment } from '../src/handlers/admin.js';
import { MockRepository } from '../src/providers/repository/mock.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin manual payment settlement', () => {
  it('settles a CASH_OK payment, confirms the booking, and logs the allowed branch', async () => {
    const policyRepo = new MockRepository();
    const paymentUpdates = [];
    const bookingUpdates = [];
    const booking = {
      id: 'b1',
      client_id: 'c1',
      booking_type: 'PAY_LATER',
      current_status: 'PENDING',
      event_id: null,
      session_type_id: 's1',
      starts_at: '2026-03-20T10:00:00.000Z',
      ends_at: '2026-03-20T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      google_event_id: 'g1',
      address_line: 'Somewhere 1, Zurich',
      maps_url: 'https://maps.example',
      currency: 'CHF',
      price: 120,
      client_first_name: 'Test',
      client_last_name: 'User',
      client_email: 'test@example.com',
      client_phone: '+41000000000',
    } as any;
    const payment = {
      id: 'p1',
      booking_id: 'b1',
      provider: 'stripe',
      provider_payment_id: 'mock_in_1',
      amount: 120,
      currency: 'CHF',
      status: 'CASH_OK',
      checkout_url: null,
      invoice_url: 'https://example.com/mock-invoice/mock_in_1',
      raw_payload: { invoice_id: 'mock_in_1' },
      paid_at: null,
    } as any;
    const refreshed = { booking_id: 'b1', client_id: 'c1', current_status: 'CONFIRMED', payment_status: 'SUCCEEDED' } as any;
    const repo = {
      getBookingById: vi.fn().mockResolvedValue(booking),
      getPaymentByBookingId: vi.fn().mockResolvedValue(payment),
      updatePayment: vi.fn().mockImplementation(async (_id, updates) => {
        paymentUpdates.push(updates);
        return { ...payment, ...updates };
      }),
      createBookingEvent: vi.fn().mockResolvedValue({
        id: 'be1',
        booking_id: 'b1',
        event_type: 'PAYMENT_SETTLED',
        source: 'ADMIN_UI',
        payload: {},
        created_at: '2026-03-01T00:00:00.000Z',
      }),
      createBookingSideEffects: vi.fn().mockResolvedValue([
        {
          id: 'se0',
          booking_event_id: 'be1',
          entity: 'CALENDAR',
          effect_intent: 'RESERVE_CALENDAR_SLOT',
          status: 'PENDING',
          expires_at: null,
          max_attempts: 5,
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-01T00:00:00.000Z',
        },
        {
          id: 'se1',
          booking_event_id: 'be1',
          entity: 'EMAIL',
          effect_intent: 'SEND_BOOKING_CONFIRMATION',
          status: 'PENDING',
          expires_at: null,
          max_attempts: 5,
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-01T00:00:00.000Z',
        },
      ]),
      updateBooking: vi.fn().mockImplementation(async (_id, updates) => {
        bookingUpdates.push(updates);
        return { ...booking, ...updates };
      }),
      getOrganizerBookings: vi.fn().mockResolvedValue([refreshed]),
      getBookingEventById: vi.fn().mockResolvedValue({ payload: {} }),
      getEventById: vi.fn().mockResolvedValue(null),
      getAllSessionTypes: vi.fn().mockResolvedValue([]),
      listSystemSettings: vi.fn().mockImplementation(() => policyRepo.listSystemSettings()),
      getLatestBookingEvent: vi.fn().mockResolvedValue(null),
      getLastBookingSideEffectAttempt: vi.fn().mockResolvedValue(null),
      createBookingSideEffectAttempt: vi.fn().mockResolvedValue({ id: 'attempt-1' }),
      updateBookingSideEffect: vi.fn().mockResolvedValue(undefined),
    };
    const ctx = makeCtx({
      providers: {
        repository: repo,
      email: {
        sendBookingConfirmation: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      },
      calendar: {
        createEvent: vi.fn().mockResolvedValue({ eventId: 'g1' }),
        updateEvent: vi.fn().mockResolvedValue(undefined),
      },
      } as any,
    });

    const req = adminRequest('POST', 'https://api.local/api/admin/bookings/b1/payment-settled', {
      note: 'Cash received at studio',
    });
    const res = await handleAdminSettleBookingPayment(req, ctx, { bookingId: 'b1' });

    expect(res.status).toBe(200);
    expect(paymentUpdates[0]).toEqual(expect.objectContaining({
      status: 'SUCCEEDED',
      paid_at: expect.any(String),
      invoice_url: 'https://example.com/mock-invoice/mock_in_1',
    }));
    expect(bookingUpdates[0]).toEqual(expect.objectContaining({ current_status: 'CONFIRMED' }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_booking_payment_settlement_decision',
      context: expect.objectContaining({
        booking_id: 'b1',
        payment_status: 'CASH_OK',
        branch_taken: 'allow_manual_payment_settlement',
        deny_reason: null,
      }),
    }));
  });
});
