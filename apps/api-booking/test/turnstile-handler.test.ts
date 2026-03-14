import { describe, expect, it, vi, afterEach } from 'vitest';

import { handleTurnstileVerify } from '../src/handlers/turnstile.js';
import { handleRequest } from '../src/router.js';
import { createProviders } from '../src/providers/index.js';
import { makeCtx, makeEnv } from './admin-helpers.js';

function makeVerifyRequest(body: Record<string, unknown>, headers?: Record<string, string>): Request {
  return new Request('https://api.local/api/antibot/turnstile/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.10',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('turnstile verification endpoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success with explicit diagnostic logs for the pass scenario', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      hostname: 'letsilluminate.co',
      action: 'managed',
      challenge_ts: '2026-03-14T10:00:00.000Z',
      'error-codes': [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const ctx = makeCtx({
      env: makeEnv({
        ANTIBOT_MODE: 'turnstile',
      }) as any,
    });

    const res = await handleTurnstileVerify(makeVerifyRequest({
      scenario: 'pass',
      token: 'token-pass',
    }), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      scenario: 'pass',
      hostname: 'letsilluminate.co',
      action: 'managed',
      challenge_ts: '2026-03-14T10:00:00.000Z',
      error_codes: [],
      request_id: 'req-1',
    });
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'turnstile_test_verify_config_evaluated',
      context: expect.objectContaining({
        antibot_mode: 'turnstile',
        scenario: 'pass',
        branch_taken: 'allow_turnstile_test_verification',
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'turnstile_test_verify_decision',
      context: expect.objectContaining({
        branch_taken: 'allow_turnstile_test_token',
        deny_reason: null,
      }),
    }));
  });

  it('returns TURNSTILE_TOKEN_INVALID with explicit deny logs for the fail scenario', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: false,
      hostname: 'letsilluminate.co',
      'error-codes': ['invalid-input-response'],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const ctx = makeCtx({
      env: makeEnv({
        ANTIBOT_MODE: 'turnstile',
      }) as any,
    });

    await expect(handleTurnstileVerify(makeVerifyRequest({
      scenario: 'fail',
      token: 'token-fail',
    }), ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'TURNSTILE_TOKEN_INVALID',
      message: 'Turnstile verification failed',
    });

    expect(ctx.operation.latestInboundErrorCode).toBe('TURNSTILE_TOKEN_INVALID');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'turnstile_test_verify_decision',
      context: expect.objectContaining({
        branch_taken: 'deny_turnstile_test_token',
        deny_reason: 'invalid-input-response',
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'turnstile_test_verify_failed',
      context: expect.objectContaining({
        status_code: 400,
        error_code: 'TURNSTILE_TOKEN_INVALID',
        deny_reason: 'TURNSTILE_TOKEN_INVALID',
      }),
    }));
  });

  it('keeps the shared error envelope and CORS headers for router failures', async () => {
    const ctx = makeCtx({
      env: makeEnv({
        ANTIBOT_MODE: 'mock',
        SITE_URL: 'https://letsilluminate.co',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
      }) as any,
    });

    const res = await handleRequest(makeVerifyRequest({
      scenario: 'pass',
      token: 'token-pass',
    }, {
      Origin: 'https://letsilluminate.co',
    }), ctx);

    expect(res.status).toBe(409);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      error: 'ANTIBOT_MODE_INACTIVE',
      message: 'ANTIBOT_MODE must be set to "turnstile"',
      request_id: expect.any(String),
    }));
  });
});

describe('turnstile provider wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the real Turnstile provider when ANTIBOT_MODE=turnstile', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      'error-codes': [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const logger = {
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      captureException: vi.fn(),
    } as any;

    const providers = createProviders(makeEnv({ ANTIBOT_MODE: 'turnstile' }) as any, logger);

    await expect(providers.antibot.verify('token-pass', '203.0.113.10')).resolves.toBeUndefined();
    expect(logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'turnstile_provider_verification_started',
    }));
  });
});
