import type { AppContext } from '../router.js';
import { ApiError, errorResponse, internalError, ok } from '../lib/errors.js';
import { DEFAULT_BOOKING_POLICY } from '../domain/booking-effect-policy.js';

interface PublicBookingPolicy {
  [key: string]: number;
  non_paid_confirmation_window_minutes: number;
  pay_now_checkout_window_minutes: number;
  pay_now_reminder_grace_minutes: number;
  pay_now_total_expiry_minutes: number;
}

function buildPublicBookingPolicy(): PublicBookingPolicy {
  return {
    non_paid_confirmation_window_minutes: DEFAULT_BOOKING_POLICY.nonPaidConfirmationWindowMinutes,
    pay_now_checkout_window_minutes: DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes,
    pay_now_reminder_grace_minutes: DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes,
    pay_now_total_expiry_minutes:
      DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes + DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes,
  };
}

function findInvalidPolicyField(
  policy: PublicBookingPolicy,
): { field: keyof PublicBookingPolicy; value: number } | null {
  const fields = Object.entries(policy) as Array<[keyof PublicBookingPolicy, number]>;
  const invalid = fields.find(([, value]) => !Number.isFinite(value) || value <= 0);
  return invalid ? { field: invalid[0], value: invalid[1] } : null;
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

    const bookingPolicy = buildPublicBookingPolicy();
    const invalidPolicyField = findInvalidPolicyField(bookingPolicy);
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
        branch_taken: invalidPolicyField
          ? 'deny_invalid_public_booking_policy'
          : 'allow_public_booking_policy',
        deny_reason: invalidPolicyField ? 'public_booking_policy_invalid' : null,
      },
    });

    if (invalidPolicyField) {
      throw internalError();
    }

    const responseBody = {
      config_version: 'booking_policy_v1',
      booking_policy: bookingPolicy,
    };

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'public_config_response_ready',
      message: 'Prepared public runtime config response',
      context: {
        path,
        request_id: ctx.requestId,
        config_version: responseBody.config_version,
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
    return errorResponse(err);
  }
}
