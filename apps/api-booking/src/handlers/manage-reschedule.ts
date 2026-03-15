import type { AppContext } from '../router.js';
import { ApiError, ok, badRequest } from '../lib/errors.js';
import { resolveBookingManageAccess, rescheduleBooking } from '../services/booking-service.js';

// POST /api/bookings/reschedule
// Body: { token: string, new_start: string, new_end: string, timezone?: string }
export async function handleManageReschedule(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    const body = await request.json() as Record<string, unknown>;
    const token = body['token'] as string | undefined;
    const adminToken = typeof body['admin_token'] === 'string' ? body['admin_token'] : null;
    const newStart = body['new_start'] as string | undefined;
    const newEnd = body['new_end'] as string | undefined;

    if (!token || !newStart || !newEnd) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'manage_booking_reschedule_input_gate_decision',
        message: 'Manage booking reschedule request denied because required fields were missing',
        context: {
          path,
          has_token: Boolean(token),
          has_new_start: Boolean(newStart),
          has_new_end: Boolean(newEnd),
          branch_taken: 'deny_missing_required_fields',
          deny_reason: 'token_new_start_or_new_end_missing',
        },
      });
      throw badRequest('token, new_start, and new_end are required');
    }

    const access = await resolveBookingManageAccess(token, adminToken, {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      operation: ctx.operation,
    });
    const booking = access.booking;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'manage_booking_reschedule_started',
      message: 'Starting public manage-booking reschedule',
      context: {
        path,
        booking_id: booking.id,
        booking_status: booking.current_status,
        new_start: newStart,
        new_end: newEnd,
        timezone: (body['timezone'] as string | undefined) ?? booking.timezone,
        branch_taken: 'reschedule_booking',
      },
    });

    const result = await rescheduleBooking(
      booking,
      {
        newStart,
        newEnd,
        timezone: (body['timezone'] as string | undefined) ?? booking.timezone,
      },
      {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        operation: ctx.operation,
      },
      {
        source: access.actorSource,
        bypassPolicyWindow: access.bypassPolicyWindow,
      },
    );
    if (!result.ok) throw badRequest(result.message, result.code);
    const updated = result.booking;

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'manage_booking_reschedule_completed',
      message: 'Public manage-booking reschedule completed',
      context: {
        path,
        booking_id: updated.id,
        updated_status: updated.current_status,
        updated_start: updated.starts_at,
        updated_end: updated.ends_at,
        branch_taken: 'return_reschedule_success',
      },
    });
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'manage_booking_reschedule_mock_email_preview_decision',
      message: 'Skipped inline mock email preview because rescheduling does not send a synchronous public email',
      context: {
        path,
        booking_id: updated.id,
        booking_status: updated.current_status,
        email_mode: ctx.env.EMAIL_MODE,
        has_mock_email_preview: false,
        branch_taken: 'skip_mock_email_preview_no_synchronous_email',
        deny_reason: 'no_synchronous_email_sent_for_reschedule',
      },
    });

    return ok({
      booking_id: updated.id,
      status: updated.current_status,
      result_code: result.code,
      message: result.message,
      starts_at: updated.starts_at,
      ends_at: updated.ends_at,
      timezone: updated.timezone,
    });
  } catch (err) {
    const statusCode = err instanceof ApiError ? err.statusCode : 500;
    if (err instanceof ApiError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'manage_booking_reschedule_failed',
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
        message: 'Manage booking reschedule failed unexpectedly',
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
