import type { AppContext } from '../router.js';
import { ApiError, internalError, ok } from '../lib/errors.js';
import { getBookingPolicyConfig, getBookingPolicyText } from '../domain/booking-effect-policy.js';
import { describeBookingPolicyValidationError } from '../config/booking-policy.js';

interface PublicBookingPolicy {
  [key: string]: number;
  non_paid_confirmation_window_minutes: number;
  pay_now_checkout_window_minutes: number;
  pay_now_reminder_grace_minutes: number;
  pay_now_total_expiry_minutes: number;
}

function buildPublicBookingPolicy(policy: Awaited<ReturnType<typeof getBookingPolicyConfig>>): PublicBookingPolicy {
  return {
    non_paid_confirmation_window_minutes: policy.nonPaidConfirmationWindowMinutes,
    pay_now_checkout_window_minutes: policy.payNowCheckoutWindowMinutes,
    pay_now_reminder_grace_minutes: policy.payNowReminderGraceMinutes,
    pay_now_total_expiry_minutes:
      policy.payNowCheckoutWindowMinutes + policy.payNowReminderGraceMinutes,
  };
}

function findInvalidPolicyField(
  policy: PublicBookingPolicy,
): { field: keyof PublicBookingPolicy; value: number } | null {
  const fields = Object.entries(policy) as Array<[keyof PublicBookingPolicy, number]>;
  const invalid = fields.find(([, value]) => !Number.isFinite(value) || value <= 0);
  return invalid ? { field: invalid[0], value: invalid[1] } : null;
}

function toPublicPolicyFieldName(field: string | null): keyof PublicBookingPolicy | null {
  if (field === 'nonPaidConfirmationWindowMinutes') return 'non_paid_confirmation_window_minutes';
  if (field === 'payNowCheckoutWindowMinutes') return 'pay_now_checkout_window_minutes';
  if (field === 'payNowReminderGraceMinutes') return 'pay_now_reminder_grace_minutes';
  return null;
}

// GET /api/config
export async function handleGetPublicConfig(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'public_config_request_started',
      message: 'Started public runtime config request handling',
      context: {
        path,
        request_id: ctx.requestId,
        branch_taken: 'evaluate_public_booking_policy',
      },
    });

    let policy;
    let bookingPolicy: PublicBookingPolicy | null = null;
    let invalidPolicyField: { field: keyof PublicBookingPolicy; value: number } | null = null;
    let configLoadError: unknown = null;
    try {
      policy = await getBookingPolicyConfig(ctx.providers.repository);
      bookingPolicy = buildPublicBookingPolicy(policy);
      invalidPolicyField = findInvalidPolicyField(bookingPolicy);
    } catch (policyError) {
      configLoadError = policyError;
      const invalidConfig = describeBookingPolicyValidationError(policyError);
      const publicField = toPublicPolicyFieldName(invalidConfig.field);
      invalidPolicyField = publicField
        ? { field: publicField, value: Number(invalidConfig.value) }
        : null;
    }
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'public_config_request_decision',
      message: 'Evaluated public runtime booking policy exposure',
      context: {
        path,
        request_id: ctx.requestId,
        booking_policy: bookingPolicy,
        invalid_policy_field: invalidPolicyField?.field ?? null,
        invalid_policy_value: invalidPolicyField?.value ?? null,
        branch_taken: invalidPolicyField || configLoadError
          ? 'deny_invalid_public_booking_policy'
          : 'allow_public_booking_policy',
        deny_reason: invalidPolicyField || configLoadError ? 'public_booking_policy_invalid' : null,
      },
    });

    if (invalidPolicyField || configLoadError || !policy || !bookingPolicy) {
      throw internalError();
    }

    const responseBody = {
      config_version: 'booking_policy_v1',
      booking_policy: bookingPolicy,
      booking_policy_text: getBookingPolicyText(policy.selfServiceLockWindowHours),
      antibot: {
        mode: ctx.env.ANTIBOT_MODE,
        turnstile: {
          enabled: ctx.env.ANTIBOT_MODE === 'turnstile',
          site_key: ctx.env.TURNSTILE_SITE_KEY ?? null,
          test_site_keys: {
            pass: ctx.env.TURNSTILE_TEST_SITE_KEY_PASS ?? null,
            fail: ctx.env.TURNSTILE_TEST_SITE_KEY_ALWAYS_FAIL ?? null,
          },
        },
      },
    };

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'public_config_response_ready',
      message: 'Prepared public runtime config response',
      context: {
        path,
        request_id: ctx.requestId,
        config_version: responseBody.config_version,
        antibot_mode: responseBody.antibot.mode,
        turnstile_enabled: responseBody.antibot.turnstile.enabled,
        branch_taken: 'public_config_response_prepared',
      },
    });

    return ok(responseBody);
  } catch (err) {
    const path = new URL(request.url).pathname;
    const statusCode = err instanceof ApiError ? err.statusCode : 500;
    if (err instanceof ApiError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'public_config_request_failed',
        message: err.message,
        context: {
          path,
          request_id: ctx.requestId,
          status_code: statusCode,
          error_code: err.code,
          branch_taken: 'handled_api_error',
          deny_reason: err.code,
        },
      });
    } else {
      ctx.logger.captureException({
        source: 'backend',
        eventType: 'uncaught_exception',
        message: 'Public runtime config request failed unexpectedly',
        error: err,
        context: {
          path,
          request_id: ctx.requestId,
          status_code: statusCode,
          branch_taken: 'unexpected_exception',
        },
      });
    }
    throw err;
  }
}
