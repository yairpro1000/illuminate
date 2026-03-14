import { describe, it, expect, vi } from 'vitest';
import { handleAdminUpdateBooking } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin update booking', () => {
  function baseBooking() {
    return { id: 'b1', client_id: 'c1', notes: null } as any;
  }

  it('updates client and booking fields and returns refreshed booking', async () => {
    const booking = baseBooking();
    const refreshed = { booking_id: 'b1', client_id: 'c1', notes: 'Hello' } as any;
    const repo = {
      getBookingById: vi.fn().mockResolvedValue(booking),
      updateClient: vi.fn().mockResolvedValue(undefined),
      updateBooking: vi.fn().mockResolvedValue(undefined),
      getOrganizerBookings: vi.fn().mockResolvedValue([refreshed]),
    };
    const ctx = makeCtx({ providers: { repository: repo } });
    const body = {
      client: { first_name: ' Jane ', last_name: ' Doe ', email: ' USER@EXAMPLE.COM ', phone: '  +41  ' },
      booking: { notes: 'Hello' },
    };
    const req = adminRequest('PATCH', 'https://api.local/api/admin/bookings/b1', body);
    const res = await handleAdminUpdateBooking(req, ctx, { bookingId: 'b1' });
    expect(res.status).toBe(200);
    expect(repo.updateClient).toHaveBeenCalledWith('c1', expect.objectContaining({ first_name: 'Jane', last_name: 'Doe', email: 'user@example.com', phone: '+41' }));
    expect(repo.updateBooking).toHaveBeenCalledWith('b1', expect.objectContaining({ notes: 'Hello' }));
    const data = await res.json();
    expect(data.booking).toEqual(refreshed);
  });

  it('returns 400 when no changes provided', async () => {
    const booking = baseBooking();
    const repo = { getBookingById: vi.fn().mockResolvedValue(booking) } as any;
    const ctx = makeCtx({ providers: { repository: repo } });
    const req = adminRequest('PATCH', 'https://api.local/api/admin/bookings/b1', {});
    await expect(handleAdminUpdateBooking(req, ctx, { bookingId: 'b1' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'No changes provided',
    });
  });

  it('accepts text/plain JSON bodies for cross-origin admin requests', async () => {
    const booking = baseBooking();
    const refreshed = { booking_id: 'b1', client_id: 'c1', notes: 'Plain text' } as any;
    const repo = {
      getBookingById: vi.fn().mockResolvedValue(booking),
      updateClient: vi.fn().mockResolvedValue(undefined),
      updateBooking: vi.fn().mockResolvedValue(undefined),
      getOrganizerBookings: vi.fn().mockResolvedValue([refreshed]),
    };
    const ctx = makeCtx({ providers: { repository: repo } });
    const req = new Request('https://api.local/api/admin/bookings/b1', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'admin@example.com',
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: JSON.stringify({
        booking: { notes: 'Plain text' },
      }),
    });

    const res = await handleAdminUpdateBooking(req, ctx, { bookingId: 'b1' });
    expect(res.status).toBe(200);
    expect(repo.updateBooking).toHaveBeenCalledWith('b1', expect.objectContaining({ notes: 'Plain text' }));
  });

  it('returns 409 with diagnostics when the client email already exists', async () => {
    const booking = baseBooking();
    const repo = {
      getBookingById: vi.fn().mockResolvedValue(booking),
      updateClient: vi.fn().mockRejectedValue(new Error('Failed to update client c1: duplicate key value violates unique constraint "clients_email_key" | code=23505 | details=Key (email)=(yairpro@gmail.com) already exists.')),
    };
    const ctx = makeCtx({ providers: { repository: repo } });
    const body = {
      client: { email: 'yairpro@gmail.com' },
    };
    const req = adminRequest('PATCH', 'https://api.local/api/admin/bookings/b1', body);

    await expect(handleAdminUpdateBooking(req, ctx, { bookingId: 'b1' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'A client with this email already exists',
    });
    expect(ctx.operation.latestInboundErrorCode).toBe('CONFLICT');
    expect(ctx.operation.latestInboundErrorMessage).toBe('A client with this email already exists');
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_booking_update_failed',
      context: expect.objectContaining({
        booking_id: 'b1',
        status_code: 409,
        error_code: 'CONFLICT',
        branch_taken: 'handled_api_error',
        deny_reason: 'CONFLICT',
      }),
    }));
  });

  it('syncs edited booking price into the pending payment and allows setting CASH_OK', async () => {
    const booking = {
      ...baseBooking(),
      booking_type: 'PAY_LATER',
      currency: 'CHF',
      client_email: 'user@example.com',
      session_type_title: 'Clarity Session',
      event_title: null,
    } as any;
    const existingPayment = {
      id: 'p1',
      booking_id: 'b1',
      status: 'PENDING',
      amount: 150,
      currency: 'CHF',
      invoice_url: 'https://example.com/mock-invoice/original',
      raw_payload: {},
    } as any;
    const refreshed = { booking_id: 'b1', client_id: 'c1', booking_price: 120, payment_amount: 120, payment_status: 'CASH_OK' } as any;
    const repo = {
      getBookingById: vi.fn().mockResolvedValue(booking),
      getPaymentByBookingId: vi.fn().mockResolvedValue(existingPayment),
      updateBooking: vi.fn().mockResolvedValue(undefined),
      updatePayment: vi.fn().mockResolvedValue(undefined),
      getOrganizerBookings: vi.fn().mockResolvedValue([refreshed]),
    };
    const payments = {
      createInvoice: vi.fn().mockResolvedValue({
        invoiceId: 'mock_in_2',
        invoiceUrl: 'https://example.com/mock-invoice/mock_in_2',
        amount: 120,
        currency: 'CHF',
      }),
    };
    const ctx = makeCtx({ providers: { repository: repo, payments } as any });

    const req = adminRequest('PATCH', 'https://api.local/api/admin/bookings/b1', {
      booking: { price: 120 },
      payment: { status: 'CASH_OK' },
    });

    const res = await handleAdminUpdateBooking(req, ctx, { bookingId: 'b1' });
    expect(res.status).toBe(200);
    expect(repo.updateBooking).toHaveBeenCalledWith('b1', expect.objectContaining({ price: 120 }));
    expect(payments.createInvoice).toHaveBeenCalledWith(expect.objectContaining({ bookingId: 'b1', amount: 120 }));
    expect(repo.updatePayment).toHaveBeenNthCalledWith(1, 'p1', expect.objectContaining({
      amount: 120,
      invoice_url: 'https://example.com/mock-invoice/mock_in_2',
    }));
    expect(repo.updatePayment).toHaveBeenNthCalledWith(2, 'p1', expect.objectContaining({ status: 'CASH_OK' }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_booking_update_payment_amount_sync_started',
      context: expect.objectContaining({
        booking_id: 'b1',
        payment_id: 'p1',
        payment_amount_after: 120,
        invoice_regenerated: true,
      }),
    }));
  });
});
