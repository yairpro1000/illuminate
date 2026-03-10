import { describe, it, expect, vi } from 'vitest';
import { handleAdminGetEvents } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin events', () => {
  it('returns published events for admin', async () => {
    const events = [
      { id: 'e1', slug: 's1', title: 'T1', starts_at: '2026-03-10T18:00:00Z', ends_at: '2026-03-10T20:00:00Z', status: 'published' },
    ];
    const ctx = makeCtx({ providers: { repository: { getAllEvents: vi.fn().mockResolvedValue(events) } } });
    const req = adminRequest('GET', 'https://api.local/api/admin/events');
    const res = await handleAdminGetEvents(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([
      { id: 'e1', slug: 's1', title: 'T1', starts_at: events[0].starts_at, ends_at: events[0].ends_at, status: 'published' },
    ]);
  });

  it('rejects unauthorized access', async () => {
    const ctx = makeCtx({ providers: { repository: { getAllEvents: vi.fn() } } });
    const req = new Request('https://api.local/api/admin/events', { method: 'GET' });
    const res = await handleAdminGetEvents(req, ctx);
    expect(res.status).toBe(401);
  });

  it('logs auth start and auth failure details for admin events', async () => {
    const ctx = makeCtx({ providers: { repository: { getAllEvents: vi.fn() } } });
    const req = new Request('https://api.local/api/admin/events', { method: 'GET' });
    const res = await handleAdminGetEvents(req, ctx);

    expect(res.status).toBe(401);
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_events_request',
      context: expect.objectContaining({
        path: '/api/admin/events',
        admin_auth_disabled: false,
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_events_request_failed',
      context: expect.objectContaining({
        path: '/api/admin/events',
        admin_auth_disabled: false,
        status_code: 401,
      }),
    }));
  });
});
