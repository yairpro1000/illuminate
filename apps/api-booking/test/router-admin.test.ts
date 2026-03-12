import { describe, it, expect, vi } from 'vitest';
import { handleRequest } from '../src/router.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

function makeOriginReq(method: string, path: string, origin = 'http://localhost:5173') {
  const req = new Request(path, { method, headers: { Origin: origin } });
  return req;
}

describe('Router integration (admin)', () => {
  it('handles OPTIONS preflight with CORS headers', async () => {
    const ctx = makeCtx();
    const res = await handleRequest(makeOriginReq('OPTIONS', 'https://api.local/api/health'), ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('routes to admin config with auth', async () => {
    const ctx = makeCtx();
    const req = adminRequest('GET', 'https://api.local/api/admin/config');
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.services)).toBe(true);
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
    expect(body).toEqual({ error: 'UNAUTHORIZED', message: expect.any(String) });
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
