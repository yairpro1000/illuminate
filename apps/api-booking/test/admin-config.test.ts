import { describe, it, expect } from 'vitest';
import { handleAdminGetConfig, handleAdminPatchConfig } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin config overrides', () => {
  it('lists services and DB-backed settings with diagnostics', async () => {
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
    expect(body.services).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'payments',
        modes: expect.arrayContaining([
          expect.objectContaining({ value: 'mock' }),
          expect.objectContaining({ value: 'stripe_sandbox' }),
          expect.objectContaining({ value: 'stripe' }),
        ]),
      }),
    ]));
    expect(body.timing_delays).toEqual(expect.objectContaining({
      config_source: 'public.system_settings',
      domains: expect.arrayContaining(['admin', 'booking', 'event', 'payment', 'processing', 'reminder']),
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: expect.any(String),
          keyname: 'adminManageTokenExpiryMinutes',
          value: expect.any(String),
          description: expect.any(String),
          description_he: expect.any(String),
        }),
      ]),
    }));
    const values = body.timing_delays.entries.map((entry: { value: string }) => Number(entry.value));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_config_request_decision',
      context: expect.objectContaining({
        branch_taken: 'allow_admin_config_response',
        config_source: 'public.system_settings',
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

    await expect(handleAdminGetConfig(req, ctx)).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
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

  it('creates a new system setting and returns refreshed config rows', async () => {
    const ctx = makeCtx({ env: { REPOSITORY_MODE: 'mock', EMAIL_MODE: 'mock', CALENDAR_MODE: 'mock', PAYMENTS_MODE: 'mock', ANTIBOT_MODE: 'mock' } as any });

    const res = await handleAdminPatchConfig(adminRequest('POST', 'https://api.local/api/admin/config', {
      domain: 'notifications',
      keyname: 'welcomeDelayMinutes',
      readable_name: 'Welcome delay',
      value_type: 'integer',
      unit: 'minutes',
      value: '15',
      description: 'Delay before the welcome email is sent.',
      description_he: 'מספר הדקות לפני שליחת מייל ברוכים הבאים.',
    }), ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.setting).toEqual(expect.objectContaining({
      domain: 'notifications',
      keyname: 'welcomeDelayMinutes',
      value: '15',
      value_type: 'integer',
    }));
    expect(body.timing_delays.domains).toContain('notifications');
    expect(body.timing_delays.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyname: 'welcomeDelayMinutes' }),
    ]));
  });

  it('updates an existing system setting and logs the mutation scope', async () => {
    const ctx = makeCtx({ env: { REPOSITORY_MODE: 'mock', EMAIL_MODE: 'mock', CALENDAR_MODE: 'mock', PAYMENTS_MODE: 'mock', ANTIBOT_MODE: 'mock' } as any });

    const res = await handleAdminPatchConfig(adminRequest('PATCH', 'https://api.local/api/admin/config', {
      original_keyname: 'adminManageTokenExpiryMinutes',
      domain: 'admin',
      keyname: 'adminManageTokenExpiryMinutes',
      readable_name: 'Admin manage token expiry',
      value_type: 'integer',
      unit: 'minutes',
      value: '45',
      description: 'Time an admin-generated management token remains valid.',
      description_he: 'מספר הדקות שטוקן ניהול שנוצר על ידי אדמין נשאר תקף.',
    }), ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.setting).toEqual(expect.objectContaining({
      keyname: 'adminManageTokenExpiryMinutes',
      value: '45',
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_config_mutation_decision',
      context: expect.objectContaining({
        mutation_scope: 'system_setting_update',
        branch_taken: 'apply_system_setting_update',
      }),
    }));
  });
});
