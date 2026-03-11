import { afterEach, describe, expect, it } from 'vitest';

import { handleGetPublicConfig } from '../src/handlers/config.js';
import { handleRequest } from '../src/router.js';
import { DEFAULT_BOOKING_POLICY } from '../src/domain/booking-effect-policy.js';
import { makeCtx } from './admin-helpers.js';

const ORIGINAL_POLICY = {
  nonPaidConfirmationWindowMinutes: DEFAULT_BOOKING_POLICY.nonPaidConfirmationWindowMinutes,
  payNowCheckoutWindowMinutes: DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes,
  payNowReminderGraceMinutes: DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes,
  paymentDueBeforeStartHours: DEFAULT_BOOKING_POLICY.paymentDueBeforeStartHours,
  processingMaxAttempts: DEFAULT_BOOKING_POLICY.processingMaxAttempts,
};

function restorePolicy(): void {
  DEFAULT_BOOKING_POLICY.nonPaidConfirmationWindowMinutes = ORIGINAL_POLICY.nonPaidConfirmationWindowMinutes;
  DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes = ORIGINAL_POLICY.payNowCheckoutWindowMinutes;
  DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes = ORIGINAL_POLICY.payNowReminderGraceMinutes;
  DEFAULT_BOOKING_POLICY.paymentDueBeforeStartHours = ORIGINAL_POLICY.paymentDueBeforeStartHours;
  DEFAULT_BOOKING_POLICY.processingMaxAttempts = ORIGINAL_POLICY.processingMaxAttempts;
}

describe('public config endpoint diagnostics', () => {
  afterEach(() => {
    restorePolicy();
  });

  it('returns public booking policy from backend source-of-truth with decision logs', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/config');

    const res = await handleGetPublicConfig(req, ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      config_version: 'booking_policy_v1',
      booking_policy: {
        non_paid_confirmation_window_minutes: DEFAULT_BOOKING_POLICY.nonPaidConfirmationWindowMinutes,
        pay_now_checkout_window_minutes: DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes,
        pay_now_reminder_grace_minutes: DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes,
        pay_now_total_expiry_minutes:
          DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes + DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes,
      },
      booking_policy_text: expect.any(String),
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
        branch_taken: 'public_config_response_prepared',
      }),
    }));
  });

  it('returns INTERNAL_ERROR and logs explicit deny reason when policy values are invalid', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/config');
    DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes = 0;

    const res = await handleGetPublicConfig(req, ctx);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'INTERNAL_ERROR',
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
    DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes = 0;
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
    await expect(res.json()).resolves.toEqual({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
});
