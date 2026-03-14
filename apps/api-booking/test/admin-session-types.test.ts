import { describe, it, expect, vi } from 'vitest';
import { handleAdminGetSessionTypes, handleAdminCreateSessionType, handleAdminUpdateSessionType } from '../src/handlers/session-types.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin session types', () => {
  it('lists all session types', async () => {
    const rows = [{ id: 's1', title: 'A' }];
    const ctx = makeCtx({ providers: { repository: { getAllSessionTypes: vi.fn().mockResolvedValue(rows) } } });
    const res = await handleAdminGetSessionTypes(adminRequest('GET', 'https://api.local/api/admin/session-types'), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_types).toEqual(rows);
  });

  it('validates required fields on create', async () => {
    const ctx = makeCtx({ providers: { repository: {} } });
    await expect(handleAdminCreateSessionType(adminRequest('POST', 'https://api.local/api/admin/session-types', { title: 'T' }), ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'slug is required',
    });
  });

  it('creates a new session type', async () => {
    const row = { id: 's2', title: 'T', slug: 't' };
    const repo = { createSessionType: vi.fn().mockResolvedValue(row) };
    const ctx = makeCtx({ providers: { repository: repo } });
    const payload = { title: 'T', slug: 't', description: 'd', duration_minutes: 60, price: 12000, currency: 'CHF', status: 'draft' };
    const res = await handleAdminCreateSessionType(adminRequest('POST', 'https://api.local/api/admin/session-types', payload), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session_type).toEqual(row);
  });

});
