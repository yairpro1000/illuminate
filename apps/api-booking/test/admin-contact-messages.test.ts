import { describe, it, expect, vi } from 'vitest';
import { handleAdminGetContactMessages } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin contact messages listing', () => {
  it('passes filters to repository and returns rows', async () => {
    const rows = [{ id: 'm1', client_id: 'c1' }];
    const getAdminContactMessages = vi.fn().mockResolvedValue(rows);
    const ctx = makeCtx({ providers: { repository: { getAdminContactMessages } } });
    const req = adminRequest('GET', 'https://api.local/api/admin/contact-messages?date=2026-03-12&client_id=c1&q=hello');
    const res = await handleAdminGetContactMessages(req, ctx);
    expect(res.status).toBe(200);
    expect(getAdminContactMessages).toHaveBeenCalledWith({
      date: '2026-03-12',
      client_id: 'c1',
      q: 'hello',
    });
    const body = await res.json();
    expect(body.rows).toEqual(rows);
  });

  it('logs diagnostic path on unauthorized access', async () => {
    const ctx = makeCtx({ providers: { repository: { getAdminContactMessages: vi.fn() } } });
    const req = new Request('https://api.local/api/admin/contact-messages?q=test', { method: 'GET' });
    await expect(handleAdminGetContactMessages(req, ctx)).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Admin authentication required',
    });
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_contact_messages_request_started',
      context: expect.objectContaining({
        path: '/api/admin/contact-messages',
        has_text_filter: true,
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_contact_messages_request_failed',
      context: expect.objectContaining({
        path: '/api/admin/contact-messages',
        status_code: 401,
      }),
    }));
  });
});
