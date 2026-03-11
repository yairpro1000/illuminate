import type { AppContext } from '../router.js';
import { ApiError, ok, badRequest, errorResponse } from '../lib/errors.js';
import { resolveBookingByManageToken, cancelBooking } from '../services/booking-service.js';

// POST /api/bookings/cancel
// Body: { token: string }
export async function handleManageCancel(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    const body = await request.json() as Record<string, unknown>;
    const token = body['token'] as string | undefined;
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

    const booking = await resolveBookingByManageToken(token, ctx.providers.repository);
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
    }, {
      source: 'public_ui',
      bypassPolicyWindow: false,
    });
    if (!result.ok) throw badRequest(result.message, result.code);

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

    return ok({
      booking_id: result.booking.id,
      status: result.booking.current_status,
      result_code: result.code,
      message: result.message,
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
    return errorResponse(err);
  }
}
