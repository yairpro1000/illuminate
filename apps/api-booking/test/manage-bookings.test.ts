import { describe, it, expect, vi } from 'vitest';
import { handleManageInfo } from '../src/handlers/manage-info.js';
import { handleRequest } from '../src/router.js';
import { makeCtx } from './admin-helpers.js';

describe('Manage booking token diagnostics', () => {
  it('returns 400 when token is missing and logs explicit deny reason', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/bookings/manage', { method: 'GET' });

    const res = await handleManageInfo(req, ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'token is required',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'manage_booking_token_gate_decision',
      context: expect.objectContaining({
        branch_taken: 'deny_missing_token',
        deny_reason: 'token_missing',
      }),
    }));
  });

  it('returns 400 for malformed edited token instead of INTERNAL_ERROR and logs diagnostics', async () => {
    const repo = {
      getBookingById: vi.fn(),
    };
    const ctx = makeCtx({ providers: { repository: repo } as any });
    const req = new Request('https://api.local/api/bookings/manage?token=m1.not-a-uuid', { method: 'GET' });

    const res = await handleManageInfo(req, ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'Invalid manage token',
    });
    expect(repo.getBookingById).not.toHaveBeenCalled();
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'manage_booking_token_gate_decision',
      context: expect.objectContaining({
        branch_taken: 'resolve_booking_by_manage_token',
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'manage_booking_info_failed',
      context: expect.objectContaining({
        status_code: 400,
        error_code: 'BAD_REQUEST',
        branch_taken: 'handled_api_error',
      }),
    }));
  });

  it('preserves CORS headers on malformed-token errors through router handling', async () => {
    const ctx = makeCtx({
      env: {
        SITE_URL: 'https://letsilluminate.co',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
      } as any,
    });
    const req = new Request('https://api.local/api/bookings/manage?token=m1.invalid-token', {
      method: 'GET',
      headers: { Origin: 'https://letsilluminate.co' },
    });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'Invalid manage token',
    });
  });
});
