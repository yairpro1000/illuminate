import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/router.js';
import { makeCtx } from './admin-helpers.js';

describe('coupon validation endpoint', () => {
  it('returns coupon details for a valid coupon code and logs the allow path', async () => {
    const ctx = makeCtx();
    const res = await handleRequest(new Request('https://api.local/api/coupons/validate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: ' israel ' }),
    }), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      coupon: {
        code: 'ISRAEL',
        discount_percent: 25,
      },
    });
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'coupon_validation_request_completed',
      context: expect.objectContaining({
        requested_coupon_code: 'ISRAEL',
        branch_taken: 'return_valid_coupon',
      }),
    }));
  });

  it('rejects an invalid coupon with the standard envelope, CORS headers, and diagnostic logs', async () => {
    const ctx = makeCtx({
      env: {
        SITE_URL: 'https://example.com',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
      } as any,
    });
    const res = await handleRequest(new Request('https://api.local/api/coupons/validate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://letsilluminate.co',
      },
      body: JSON.stringify({ code: 'BADCODE' }),
    }), ctx);

    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    await expect(res.json()).resolves.toEqual({
      error: 'NOT_FOUND',
      message: 'Coupon code is invalid',
      request_id: 'req-1',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'coupon_validation_request_failed',
      context: expect.objectContaining({
        branch_taken: 'deny_coupon_not_found',
        deny_reason: 'coupon_not_found',
        status_code: 404,
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'route_execution_failed',
      context: expect.objectContaining({
        status_code: 404,
        branch_taken: 'handled_api_error',
      }),
    }));
  });
});
