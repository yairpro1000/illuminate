import { describe, it, expect, vi } from 'vitest';
import { handleAdminUpdateBooking } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin update booking', () => {
  function baseBooking() {
    return { id: 'b1', client_id: 'c1', notes: null } as any;
  }

  it('updates client and booking fields and returns refreshed booking', async () => {
    const booking = baseBooking();
    const refreshed = { booking_id: 'b1', client_id: 'c1', attended: true, notes: 'Hello' } as any;
    const repo = {
      getBookingById: vi.fn().mockResolvedValue(booking),
      updateClient: vi.fn().mockResolvedValue(undefined),
      updateBooking: vi.fn().mockResolvedValue(undefined),
      getOrganizerBookings: vi.fn().mockResolvedValue([refreshed]),
    };
    const ctx = makeCtx({ providers: { repository: repo } });
    const body = {
      client: { first_name: ' Jane ', last_name: ' Doe ', email: ' USER@EXAMPLE.COM ', phone: '  +41  ' },
      booking: { attended: true, notes: 'Hello' },
    };
    const req = adminRequest('PATCH', 'https://api.local/api/admin/bookings/b1', body);
    const res = await handleAdminUpdateBooking(req, ctx, { bookingId: 'b1' });
    expect(res.status).toBe(200);
    expect(repo.updateClient).toHaveBeenCalledWith('c1', expect.objectContaining({ first_name: 'Jane', last_name: 'Doe', email: 'user@example.com', phone: '+41' }));
    expect(repo.updateBooking).toHaveBeenCalledWith('b1', expect.objectContaining({ attended: true, notes: 'Hello' }));
    const data = await res.json();
    expect(data.booking).toEqual(refreshed);
  });

  it('returns 400 when no changes provided', async () => {
    const booking = baseBooking();
    const repo = { getBookingById: vi.fn().mockResolvedValue(booking) } as any;
    const ctx = makeCtx({ providers: { repository: repo } });
    const req = adminRequest('PATCH', 'https://api.local/api/admin/bookings/b1', {});
    const res = await handleAdminUpdateBooking(req, ctx, { bookingId: 'b1' });
    expect(res.status).toBe(400);
  });
});
