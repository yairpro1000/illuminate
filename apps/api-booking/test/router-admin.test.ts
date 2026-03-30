import { describe, it, expect, vi } from 'vitest';
import { handleRequest } from '../src/router.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

function makeOriginReq(method: string, path: string, origin = 'http://localhost:5173') {
  const req = new Request(path, { method, headers: { Origin: origin } });
  return req;
}

describe('Router integration (admin)', () => {
  it('handles OPTIONS preflight with CORS headers and logs the allowed branch', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://letsilluminate.co',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-illuminate-ui-test-mode, x-request-id, x-correlation-id',
      },
    });
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('x-illuminate-ui-test-mode');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cors_preflight_evaluation_started',
      context: expect.objectContaining({
        branch_taken: 'evaluate_cors_preflight',
        requested_headers: ['x-illuminate-ui-test-mode', 'x-request-id', 'x-correlation-id'],
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cors_preflight_evaluation_completed',
      context: expect.objectContaining({
        branch_taken: 'allow_cors_preflight',
        allowed_origin: 'https://letsilluminate.co',
        requested_headers: ['x-illuminate-ui-test-mode', 'x-request-id', 'x-correlation-id'],
        deny_reason: null,
      }),
    }));
  });

  it('rejects disallowed OPTIONS preflight requests and logs the deny reason', async () => {
    const ctx = makeCtx({ env: { SITE_URL: 'https://example.com', ADMIN_DEV_EMAIL: '' } as any });
    const req = new Request('https://api.local/api/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-illuminate-ui-test-mode',
      },
    });
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cors_preflight_evaluation_completed',
      context: expect.objectContaining({
        branch_taken: 'deny_cors_preflight_origin_not_allowed',
        deny_reason: 'origin_not_allowed',
        request_origin: 'https://evil.example',
        requested_headers: ['x-illuminate-ui-test-mode'],
        status_code: 403,
      }),
    }));
  });

  it('allows pages.dev preflight requests when preview origin support is enabled', async () => {
    const ctx = makeCtx({
      env: {
        SITE_URL: 'https://letsilluminate.co',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
        API_ALLOW_PAGES_DEV_ORIGINS: 'true',
      } as any,
    });
    const req = new Request('https://illuminate.yairpro.workers.dev/api/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://preview-branch.pages.dev',
        'Access-Control-Request-Method': 'GET',
      },
    });
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://preview-branch.pages.dev');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cors_preflight_evaluation_completed',
      context: expect.objectContaining({
        branch_taken: 'allow_cors_preflight',
        allowed_origin: 'https://preview-branch.pages.dev',
        allow_pages_dev_origins: true,
      }),
    }));
  });

  it('routes to admin config with auth', async () => {
    const ctx = makeCtx();
    const req = adminRequest('GET', 'https://api.local/api/admin/config');
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.services)).toBe(true);
  });

  it('routes GET /api/admin/clients to the admin clients handler', async () => {
    const ctx = makeCtx();
    const req = adminRequest('GET', 'https://api.local/api/admin/clients');
    const res = await handleRequest(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it('routes GET /api/admin/session-types/:id to the session-type detail handler', async () => {
    const ctx = makeCtx();
    const req = adminRequest('GET', 'https://api.local/api/admin/session-types/mock-st-1');
    const res = await handleRequest(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.session_type).toEqual(expect.objectContaining({
      id: 'mock-st-1',
    }));
    expect(body.availability).toEqual(expect.objectContaining({
      mode: expect.any(String),
      upcoming_weeks: expect.any(Array),
    }));
  });

  it('routes PUT /api/admin/session-types/:id/availability-overrides/:weekStartDate to the override handler', async () => {
    const ctx = makeCtx();
    const req = adminRequest(
      'PUT',
      'https://api.local/api/admin/session-types/mock-st-1/availability-overrides/2026-03-23',
      { mode: 'FORCE_CLOSED', override_weekly_booking_limit: null },
    );
    const res = await handleRequest(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.override).toEqual(expect.objectContaining({
      session_type_id: 'mock-st-1',
      week_start_date: '2026-03-23',
      mode: 'FORCE_CLOSED',
    }));
    expect(body.week_summary).toEqual(expect.objectContaining({
      week_start_date: '2026-03-23',
      mode: 'FORCE_CLOSED',
    }));
  });

  it('routes POST admin config updates without preflight-only methods', async () => {
    const ctx = makeCtx({ env: { REPOSITORY_MODE: 'mock', EMAIL_MODE: 'mock', CALENDAR_MODE: 'mock', PAYMENTS_MODE: 'mock', ANTIBOT_MODE: 'mock' } as any });
    const req = adminRequest('POST', 'https://api.local/api/admin/config', { key: 'email', mode: 'resend' });
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effective_mode).toBe('resend');
  });

  it('returns 401 for admin config without auth', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/admin/config', { method: 'GET' });
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(401);
  });

  it('adds CORS headers to admin auth errors', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/admin/config', {
      method: 'GET',
      headers: { Origin: 'https://admin.letsilluminate.co' },
    });
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.letsilluminate.co');
  });

  it('adds CORS headers to admin contact messages auth errors', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/admin/contact-messages', {
      method: 'GET',
      headers: { Origin: 'https://admin.letsilluminate.co' },
    });
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.letsilluminate.co');
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({ error: 'UNAUTHORIZED', message: expect.any(String) }));
  });

  it('adds CORS headers to non-api 404 responses', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/nope', {
      method: 'GET',
      headers: { Origin: 'https://admin.letsilluminate.co' },
    });
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.letsilluminate.co');
    expect(ctx.logger.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 404,
      success: true,
    }));
  });

  it('logs 405 as a non-server error request', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/health', { method: 'POST' });
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(405);
    expect(ctx.logger.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 405,
      success: true,
    }));
  });
});
