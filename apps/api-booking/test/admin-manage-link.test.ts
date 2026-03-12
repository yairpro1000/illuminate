import { describe, it, expect, vi } from 'vitest';
import { handleAdminCreateBookingManageLink } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin manage link creation', () => {
  it('returns a signed admin manage link for an existing booking', async () => {
    const bookingId = '00000000-0000-4000-8000-000000000001';
    const getBookingById = vi.fn().mockResolvedValue({
      id: bookingId,
      client_id: 'client-1',
      event_id: null,
      session_type_id: 'session-type-1',
      starts_at: '2026-03-22T10:00:00.000Z',
      ends_at: '2026-03-22T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      google_event_id: null,
      address_line: 'Somewhere 1, Zurich',
      maps_url: 'https://maps.example',
      current_status: 'SLOT_CONFIRMED',
      notes: null,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    });
    const ctx = makeCtx({
      providers: { repository: { getBookingById } } as any,
    });
    ctx.env.JOB_SECRET = 'test-secret';

    const req = adminRequest('POST', `https://api.local/api/admin/bookings/${bookingId}/manage-link`, {});
    const res = await handleAdminCreateBookingManageLink(req, ctx, { bookingId });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking_id).toBe(bookingId);
    expect(body.url).toContain('https://example.com/manage.html?');
    expect(body.url).toContain(`token=m1.${bookingId}`);
    expect(body.url).toContain('admin_token=');
    expect(typeof body.expires_at).toBe('string');
    expect(getBookingById).toHaveBeenCalledWith(bookingId);
  });
});
