import { describe, it, expect } from 'vitest';
import { handleAdminGetConfig, handleAdminPatchConfig } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin config overrides', () => {
  it('lists services with env and effective mode', async () => {
    const ctx = makeCtx({ env: { REPOSITORY_MODE: 'mock', EMAIL_MODE: 'mock', CALENDAR_MODE: 'mock', PAYMENTS_MODE: 'mock', ANTIBOT_MODE: 'mock' } as any });
    const req = adminRequest('GET', 'https://api.local/api/admin/config');
    const res = await handleAdminGetConfig(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.services)).toBe(true);
    expect(body.services.length).toBeGreaterThan(0);
    for (const svc of body.services) {
      expect(svc.effective_mode).toBeTruthy();
      expect(svc.env_mode).toBeTruthy();
    }
  });

  it('sets and clears an override', async () => {
    const ctx = makeCtx({ env: { REPOSITORY_MODE: 'mock', EMAIL_MODE: 'mock', CALENDAR_MODE: 'mock', PAYMENTS_MODE: 'mock', ANTIBOT_MODE: 'mock' } as any });
    // set override to non-env wired mode (email: resend)
    let res = await handleAdminPatchConfig(adminRequest('PATCH', 'https://api.local/api/admin/config', { key: 'email', mode: 'resend' }), ctx);
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.key).toBe('email');
    expect(body.effective_mode).toBe('resend');
    expect(body.override_mode).toBe('resend');
    // clear override by matching env mode (back to mock)
    res = await handleAdminPatchConfig(adminRequest('PATCH', 'https://api.local/api/admin/config', { key: 'email', mode: 'mock' }), ctx);
    body = await res.json();
    expect(body.key).toBe('email');
    expect(body.effective_mode).toBe('mock');
    expect(body.override_mode).toBeNull();
  });

  it('accepts text/plain JSON bodies for config updates', async () => {
    const ctx = makeCtx({ env: { REPOSITORY_MODE: 'mock', EMAIL_MODE: 'mock', CALENDAR_MODE: 'mock', PAYMENTS_MODE: 'mock', ANTIBOT_MODE: 'mock' } as any });
    const req = new Request('https://api.local/api/admin/config', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'admin@example.com',
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: JSON.stringify({ key: 'email', mode: 'resend' }),
    });

    const res = await handleAdminPatchConfig(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effective_mode).toBe('resend');
  });
});
