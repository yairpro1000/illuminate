import type { AppContext } from '../router.js';
import { ApiError, ok, badRequest, errorResponse } from '../lib/errors.js';
import { evaluateManageBookingPolicy, resolveBookingByManageToken } from '../services/booking-service.js';

// GET /api/bookings/manage?token=<raw>
export async function handleManageInfo(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!token) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'manage_booking_token_gate_decision',
        message: 'Manage booking info request denied because token was missing',
        context: {
          path,
          branch_taken: 'deny_missing_token',
          deny_reason: 'token_missing',
        },
      });
      throw badRequest('token is required');
    }

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'manage_booking_token_gate_decision',
      message: 'Evaluating manage booking info token gate',
      context: {
        path,
        token_meta: summarizeToken(token),
        branch_taken: 'resolve_booking_by_manage_token',
      },
    });

    const booking = await resolveBookingByManageToken(token, ctx.providers.repository);
    const event = booking.event_id ? await ctx.providers.repository.getEventById(booking.event_id) : null;
    const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
    const policy = evaluateManageBookingPolicy(booking.starts_at);
    const paid = payment?.status === 'succeeded' || booking.current_status === 'PAID' || booking.current_status === 'REFUNDED';

    const source = booking.event_id ? 'event' : 'session';
    const blockedStatuses = ['EXPIRED', 'CANCELED', 'COMPLETED', 'NO_SHOW', 'REFUNDED'];
    const canReschedule = source === 'session' && policy.canSelfServeChange && !blockedStatuses.includes(booking.current_status);
    const canCancel = policy.canSelfServeChange && !blockedStatuses.includes(booking.current_status);
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'manage_booking_actions_gate_decision',
      message: 'Computed manage-booking actions',
      context: {
        path,
        booking_id: booking.id,
        booking_status: booking.current_status,
        booking_source: source,
        starts_at: booking.starts_at,
        hours_before_start: policy.hoursBeforeStart,
        paid,
        can_reschedule: canReschedule,
        can_cancel: canCancel,
        branch_taken: 'return_manage_booking_payload',
      },
    });

    return ok({
      booking_id: booking.id,
      source,
      status: booking.current_status,
      session_type_id: booking.session_type_id,
      title: event?.title ?? 'ILLUMINATE 1:1 Session',
      starts_at: booking.starts_at,
      ends_at: booking.ends_at,
      timezone: booking.timezone,
      address_line: booking.address_line,
      maps_url: booking.maps_url,
      client: {
        first_name: booking.client_first_name ?? '',
        last_name: booking.client_last_name ?? null,
        email: booking.client_email ?? '',
        phone: booking.client_phone ?? null,
      },
      actions: {
        can_reschedule: canReschedule,
        can_cancel: canCancel,
      },
      is_paid: paid,
      policy: {
        text: policy.policyText,
        can_self_serve_change: policy.canSelfServeChange,
        lock_window_hours: 24,
        locked_message: 'This session starts in less than 24 hours.\nAccording to the booking policy:\n• cancellations are not refundable\n• rescheduling is no longer available online\nIf you have an emergency, please contact Yair directly.',
      },
      event: event
        ? {
            id: event.id,
            slug: event.slug,
            title: event.title,
            starts_at: event.starts_at,
          }
        : null,
    });
  } catch (err) {
    const statusCode = err instanceof ApiError ? err.statusCode : 500;
    if (err instanceof ApiError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'manage_booking_info_failed',
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
        message: 'Manage booking info failed unexpectedly',
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

function summarizeToken(token: string): {
  has_token: boolean;
  token_segment_count: number;
  token_version: string | null;
  booking_id_shape: string;
} {
  const parts = token.split('.');
  const candidate = parts[0] === 'm1' ? (parts[1] ?? '') : token;
  const bookingIdShape = /^[0-9a-f-]{1,80}$/i.test(candidate)
    ? (candidate.length === 36 ? 'uuid_like' : 'uuid_charset_nonstandard_length')
    : 'not_uuid_charset';
  return {
    has_token: true,
    token_segment_count: parts.length,
    token_version: parts[0] || null,
    booking_id_shape: bookingIdShape,
  };
}
