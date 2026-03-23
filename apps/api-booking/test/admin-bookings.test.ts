import { describe, it, expect, vi } from 'vitest';
import { handleAdminGetBookingDetail, handleAdminGetBookings } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin bookings listing', () => {
  it('passes filters to repository and returns rows', async () => {
    const rows = [{ booking_id: 'b1', client_id: 'c1' }];
    const getOrganizerBookingSummaries = vi.fn().mockResolvedValue(rows);
    const ctx = makeCtx({ providers: { repository: { getOrganizerBookingSummaries } } });
    const req = adminRequest('GET', 'https://api.local/api/admin/bookings?source=event&event_id=evt1');
    const res = await handleAdminGetBookings(req, ctx);
    expect(res.status).toBe(200);
    expect(getOrganizerBookingSummaries).toHaveBeenCalledWith({
      booking_kind: 'event',
      event_id: 'evt1',
      date: undefined,
      client_id: undefined,
      current_status: undefined,
    });
    const body = await res.json();
    expect(body.rows).toEqual(rows);
  });

  it('rejects unauthorized access', async () => {
    const ctx = makeCtx({ providers: { repository: { getOrganizerBookingSummaries: vi.fn() } } });
    const req = new Request('https://api.local/api/admin/bookings', { method: 'GET' });
    await expect(handleAdminGetBookings(req, ctx)).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Admin authentication required',
    });
  });

  it('loads one booking detail through the shared read model owner', async () => {
    const getBookingById = vi.fn().mockResolvedValue({
      id: 'b1',
      client_id: 'c1',
      event_id: null,
      session_type_id: 'session-1',
      booking_type: 'PAY_NOW',
      starts_at: '2026-03-20T10:00:00.000Z',
      ends_at: '2026-03-20T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      google_event_id: null,
      meeting_provider: null,
      meeting_link: null,
      address_line: 'Via Example 1, Lugano',
      maps_url: 'https://maps.example',
      price: 150,
      currency: 'CHF',
      coupon_code: 'VIP',
      current_status: 'CONFIRMED',
      notes: 'note',
      created_at: '2026-03-10T10:00:00.000Z',
      updated_at: '2026-03-10T10:00:00.000Z',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.com',
      client_phone: null,
      event_title: null,
      session_type_title: 'Clarity Session',
    });
    const getPaymentByBookingId = vi.fn().mockResolvedValue({
      id: 'pay-1',
      booking_id: 'b1',
      amount: 150,
      currency: 'CHF',
      status: 'SUCCEEDED',
      provider: 'stripe',
      checkout_url: null,
      invoice_url: 'https://invoice.example',
      refund_status: 'NONE',
      refund_amount: null,
      refund_currency: null,
      stripe_customer_id: 'cus_1',
      stripe_checkout_session_id: 'cs_1',
      stripe_payment_intent_id: 'pi_1',
      stripe_invoice_id: 'in_1',
      stripe_payment_link_id: null,
      stripe_refund_id: null,
      stripe_credit_note_id: null,
      stripe_receipt_url: 'https://receipt.example',
      stripe_credit_note_url: null,
      paid_at: '2026-03-10T10:05:00.000Z',
      created_at: '2026-03-10T10:05:00.000Z',
      updated_at: '2026-03-10T10:05:00.000Z',
      raw_payload: {},
    });
    const listBookingEvents = vi.fn().mockResolvedValue([
      {
        id: 'evt-booking-1',
        booking_id: 'b1',
        event_type: 'BOOKING_FORM_SUBMITTED',
        source: 'PUBLIC_UI',
        payload: {},
        status: 'SUCCESS',
        error_message: null,
        completed_at: '2026-03-10T10:00:00.000Z',
        created_at: '2026-03-10T10:00:00.000Z',
        updated_at: '2026-03-10T10:00:00.000Z',
      },
      {
        id: 'evt-booking-2',
        booking_id: 'b1',
        event_type: 'PAYMENT_SETTLED',
        source: 'WEBHOOK',
        payload: {},
        status: 'SUCCESS',
        error_message: null,
        completed_at: '2026-03-10T10:05:00.000Z',
        created_at: '2026-03-10T10:05:00.000Z',
        updated_at: '2026-03-10T10:05:00.000Z',
      },
    ]);
    const listBookingSideEffectsForEvents = vi.fn().mockResolvedValue([
      {
        id: 'se-1',
        booking_event_id: 'evt-booking-2',
        entity: 'PAYMENTS',
        effect_intent: 'CREATE_STRIPE_CHECKOUT',
        status: 'SUCCESS',
        expires_at: null,
        max_attempts: 5,
        created_at: '2026-03-10T10:05:10.000Z',
        updated_at: '2026-03-10T10:05:10.000Z',
      },
    ]);
    const listBookingSideEffectAttemptsForSideEffects = vi.fn().mockResolvedValue([
      {
        id: 'attempt-1',
        booking_side_effect_id: 'se-1',
        attempt_num: 1,
        api_log_id: null,
        status: 'SUCCESS',
        error_message: null,
        created_at: '2026-03-10T10:05:20.000Z',
        updated_at: '2026-03-10T10:05:20.000Z',
        completed_at: '2026-03-10T10:05:20.000Z',
      },
    ]);
    const ctx = makeCtx({
      providers: {
        repository: {
          getBookingById,
          getPaymentByBookingId,
          listBookingEvents,
          listBookingSideEffectsForEvents,
          listBookingSideEffectAttemptsForSideEffects,
        },
      },
    });

    const req = adminRequest('GET', 'https://api.local/api/admin/bookings/b1');
    const res = await handleAdminGetBookingDetail(req, ctx, { bookingId: 'b1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.row).toEqual(expect.objectContaining({
      booking_id: 'b1',
      booking_coupon_code: 'VIP',
      payment_status: 'SUCCEEDED',
      payment_invoice_url: 'https://invoice.example',
      latest_event_type: 'PAYMENT_SETTLED',
      payment_latest_side_effect_attempt_status: 'SUCCESS',
    }));
  });
});
