import { describe, it, expect, vi } from 'vitest';
import { handleAdminGetBookings } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin bookings listing', () => {
  it('passes filters to repository and returns rows', async () => {
    const rows = [{ booking_id: 'b1', client_id: 'c1' }];
    const getOrganizerBookings = vi.fn().mockResolvedValue(rows);
    const ctx = makeCtx({ providers: { repository: { getOrganizerBookings } } });
    const req = adminRequest('GET', 'https://api.local/api/admin/bookings?source=event&event_id=evt1');
    const res = await handleAdminGetBookings(req, ctx);
    expect(res.status).toBe(200);
    expect(getOrganizerBookings).toHaveBeenCalledWith({
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
    const ctx = makeCtx({ providers: { repository: { getOrganizerBookings: vi.fn() } } });
    const req = new Request('https://api.local/api/admin/bookings', { method: 'GET' });
    await expect(handleAdminGetBookings(req, ctx)).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Admin authentication required',
    });
  });
});
