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

  it('returns 401 for admin config without auth', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/admin/config', { method: 'GET' });
    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(401);
  });
});
