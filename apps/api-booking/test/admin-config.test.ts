import { describe, it, expect } from 'vitest';
import { handleAdminGetConfig, handleAdminPatchConfig } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin config overrides', () => {
  it('lists services and timing delays with diagnostics', async () => {
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
    expect(body.timing_delays).toEqual(expect.objectContaining({
      config_path: 'apps/api-booking/src/config/booking-policy.json',
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: expect.any(String),
          keyname: 'adminManageTokenExpiryMinutes',
          value: expect.any(Number),
          description: expect.any(String),
        }),
      ]),
    }));
    const values = body.timing_delays.entries.map((entry: { value: number }) => entry.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_config_request_decision',
      context: expect.objectContaining({
        branch_taken: 'allow_admin_config_response',
        config_path: 'apps/api-booking/src/config/booking-policy.json',
        deny_reason: null,
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_config_response_ready',
      context: expect.objectContaining({
        branch_taken: 'admin_config_response_prepared',
      }),
    }));
  });

  it('returns explicit auth failure diagnostics for missing admin auth', async () => {
    const ctx = makeCtx({ env: { REPOSITORY_MODE: 'mock', EMAIL_MODE: 'mock', CALENDAR_MODE: 'mock', PAYMENTS_MODE: 'mock', ANTIBOT_MODE: 'mock' } as any });
    const req = new Request('https://api.local/api/admin/config');

    const res = await handleAdminGetConfig(req, ctx);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: 'UNAUTHORIZED',
      message: 'Admin authentication required',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_config_request_failed',
      context: expect.objectContaining({
        status_code: 401,
        error_code: 'UNAUTHORIZED',
        branch_taken: 'handled_api_error',
        deny_reason: 'UNAUTHORIZED',
      }),
    }));
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
