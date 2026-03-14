import { afterEach, describe, expect, it } from 'vitest';

import { handleGetPublicConfig } from '../src/handlers/config.js';
import { handleRequest } from '../src/router.js';
import {
  applyBookingPolicyOverridesForTests,
  getBookingPolicyConfig,
  resetBookingPolicyForTests,
} from '../src/domain/booking-effect-policy.js';
import { MockRepository } from '../src/providers/repository/mock.js';
import { makeCtx } from './admin-helpers.js';

describe('public config endpoint diagnostics', () => {
  afterEach(() => {
    resetBookingPolicyForTests();
  });

  it('returns public booking policy from backend source-of-truth with decision logs', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/config');
    const policy = await getBookingPolicyConfig(new MockRepository());

    const res = await handleGetPublicConfig(req, ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      config_version: 'booking_policy_v1',
      booking_policy: {
        non_paid_confirmation_window_minutes: policy.nonPaidConfirmationWindowMinutes,
        pay_now_checkout_window_minutes: policy.payNowCheckoutWindowMinutes,
        pay_now_reminder_grace_minutes: policy.payNowReminderGraceMinutes,
        pay_now_total_expiry_minutes:
          policy.payNowCheckoutWindowMinutes + policy.payNowReminderGraceMinutes,
      },
      booking_policy_text: expect.any(String),
      antibot: {
        mode: 'mock',
        turnstile: {
          enabled: false,
          site_key: 'site-key-live',
          test_site_keys: {
            pass: 'site-key-pass',
            fail: 'site-key-fail',
          },
          env: {
            ANTIBOT_MODE: 'mock',
            TURNSTILE_SITE_KEY: 'site-key-live',
            TURNSTILE_TEST_SITE_KEY_PASS: 'site-key-pass',
            TURNSTILE_TEST_SITE_KEY_ALWAYS_FAIL: 'site-key-fail',
            TURNSTILE_SECRET_KEY_present: true,
            TURNSTILE_TEST_SECRET_KEY_PASS_present: true,
            TURNSTILE_TEST_SECRET_KEY_ALWAYS_FAIL_present: true,
          },
        },
      },
    });

    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_config_request_decision',
      context: expect.objectContaining({
        branch_taken: 'allow_public_booking_policy',
        deny_reason: null,
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_config_response_ready',
      context: expect.objectContaining({
        antibot_mode: 'mock',
        turnstile_enabled: false,
        turnstile_env_snapshot: expect.objectContaining({
          TURNSTILE_TEST_SITE_KEY_PASS: 'site-key-pass',
          TURNSTILE_TEST_SITE_KEY_ALWAYS_FAIL: 'site-key-fail',
        }),
        branch_taken: 'public_config_response_prepared',
      }),
    }));
  });

  it('returns INTERNAL_ERROR and logs explicit deny reason when policy values are invalid', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/config');
    applyBookingPolicyOverridesForTests({ payNowReminderGraceMinutes: 0 });

    await expect(handleGetPublicConfig(req, ctx)).rejects.toMatchObject({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_config_request_decision',
      context: expect.objectContaining({
        branch_taken: 'deny_invalid_public_booking_policy',
        deny_reason: 'public_booking_policy_invalid',
        invalid_policy_field: 'pay_now_reminder_grace_minutes',
        invalid_policy_value: 0,
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_config_request_failed',
      context: expect.objectContaining({
        status_code: 500,
        error_code: 'INTERNAL_ERROR',
        branch_taken: 'handled_api_error',
        deny_reason: 'INTERNAL_ERROR',
      }),
    }));
  });

  it('keeps CORS headers for router-level failures on /api/config', async () => {
    applyBookingPolicyOverridesForTests({ payNowReminderGraceMinutes: 0 });
    const ctx = makeCtx({
      env: {
        SITE_URL: 'https://letsilluminate.co',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
      } as any,
    });
    const req = new Request('https://api.local/api/config', {
      method: 'GET',
      headers: { Origin: 'https://letsilluminate.co' },
    });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(500);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    }));
  });

  it('can be overridden from the shared booking policy config in tests', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/config');
    applyBookingPolicyOverridesForTests({
      nonPaidConfirmationWindowMinutes: 9,
      payNowCheckoutWindowMinutes: 14,
      payNowReminderGraceMinutes: 4,
      selfServiceLockWindowHours: 12,
    });

    const res = await handleGetPublicConfig(req, ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_policy: expect.objectContaining({
        non_paid_confirmation_window_minutes: 9,
        pay_now_checkout_window_minutes: 14,
        pay_now_reminder_grace_minutes: 4,
        pay_now_total_expiry_minutes: 18,
      }),
      antibot: expect.objectContaining({
        mode: 'mock',
        turnstile: expect.objectContaining({
          env: expect.objectContaining({
            ANTIBOT_MODE: 'mock',
          }),
        }),
      }),
      booking_policy_text: expect.stringContaining('up to 12 hours before the session'),
    }));
  });
});
