import type { AppContext } from '../router.js';
import { ApiError, ok, badRequest } from '../lib/errors.js';
import { consumeLatestEmailDispatch } from '../lib/execution.js';
import { cancelBooking, resolveBookingManageAccess } from '../services/booking-service.js';

// POST /api/bookings/cancel
// Body: { token: string }
export async function handleManageCancel(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch (parseError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'manage_booking_cancel_input_gate_decision',
        message: 'Manage booking cancel request denied because JSON body was invalid',
        context: {
          path,
          branch_taken: 'deny_invalid_json_body',
          deny_reason: 'request_json_parse_failed',
          parse_error: parseError instanceof Error ? parseError.message : String(parseError),
        },
      });
      throw badRequest('Invalid JSON body');
    }
    const token = body['token'] as string | undefined;
    const adminToken = typeof body['admin_token'] === 'string' ? body['admin_token'] : null;
    if (!token) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'manage_booking_cancel_token_gate_decision',
        message: 'Manage booking cancel request denied because token was missing',
        context: {
          path,
          branch_taken: 'deny_missing_token',
          deny_reason: 'token_missing',
        },
      });
      throw badRequest('token is required');
    }

    const access = await resolveBookingManageAccess(token, adminToken, {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      operation: ctx.operation,
      siteUrl: ctx.siteUrl,
    });
    const booking = access.booking;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'manage_booking_cancel_started',
      message: 'Starting public manage-booking cancel',
      context: {
        path,
        booking_id: booking.id,
        booking_status: booking.current_status,
        branch_taken: 'cancel_booking',
      },
    });

    const result = await cancelBooking(booking, {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      operation: ctx.operation,
      siteUrl: ctx.siteUrl,
    }, {
      source: access.actorSource,
      bypassPolicyWindow: access.bypassPolicyWindow,
    });
    if (!result.ok) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'manage_booking_cancel_result_gate_decision',
        message: 'Manage booking cancel denied by booking service result gate',
        context: {
          path,
          booking_id: booking.id,
          booking_status: booking.current_status,
          result_code: result.code,
          result_message: result.message,
          actor_source: access.actorSource,
          policy_bypass_applied: access.bypassPolicyWindow,
          branch_taken: 'deny_cancel_result_not_ok',
          deny_reason: result.code,
        },
      });
      throw badRequest(result.message, result.code);
    }

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'manage_booking_cancel_completed',
      message: 'Public manage-booking cancel completed',
      context: {
        path,
        booking_id: result.booking.id,
        booking_status: result.booking.current_status,
        branch_taken: 'return_cancel_success',
      },
    });

    const emailDispatch = consumeLatestEmailDispatch(ctx.operation);
    const mockEmailPreview = emailDispatch?.mockEmailPreview ?? null;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'manage_booking_cancel_mock_email_preview_decision',
      message: 'Evaluated inline mock email preview for manage-booking cancellation',
      context: {
        path,
        booking_id: result.booking.id,
        booking_status: result.booking.current_status,
        email_mode: ctx.env.EMAIL_MODE,
        ui_test_mode: emailDispatch?.uiTestMode ?? null,
        has_mock_email_preview: Boolean(mockEmailPreview),
        email_kind: emailDispatch?.emailKind ?? null,
        branch_taken: emailDispatch?.branchTaken ?? 'skip_mock_email_preview_email_not_dispatched',
        deny_reason: emailDispatch?.denyReason ?? 'email_not_dispatched_in_request',
      },
    });

    return ok({
      booking_id: result.booking.id,
      status: result.booking.current_status,
      result_code: result.code,
      message: result.message,
      ...(mockEmailPreview ? { mock_email_preview: mockEmailPreview } : {}),
    });
  } catch (err) {
    const statusCode = err instanceof ApiError ? err.statusCode : 500;
    if (err instanceof ApiError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'manage_booking_cancel_failed',
        message: err.message,
        context: {
          path,
          status_code: statusCode,
          error_code: err.code,
          branch_taken: 'handled_api_error',
          deny_reason: err.message,
        },
      });
    } else {
      ctx.logger.captureException({
        source: 'backend',
        eventType: 'uncaught_exception',
        message: 'Manage booking cancel failed unexpectedly',
        error: err,
        context: {
          path,
          status_code: statusCode,
          branch_taken: 'unexpected_exception',
        },
      });
    }
    throw err;
  }
}
