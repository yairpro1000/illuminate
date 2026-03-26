import type { AppContext } from '../router.js';
import { ApiError, ok, badRequest } from '../lib/errors.js';
import { getBookingPolicyConfig, getBookingPolicyText } from '../domain/booking-effect-policy.js';
import {
  buildPublicCalendarEventInfo,
  isSessionCalendarSyncPendingRetry,
} from '../services/booking-service.js';
import { resolveBookingManageAccess } from '../services/booking-access-service.js';
import { evaluateManageBookingPolicy, resolveManageActionState } from '../services/booking-public-action-service.js';
import { loadBookingWithLatestPayment } from '../services/booking-read-model.js';
import { effectiveRefundStatus } from '../services/refund-service.js';

// GET /api/bookings/manage?token=<raw>
export async function handleManageInfo(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const adminToken = url.searchParams.get('admin_token');
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
    const bookingPolicy = await getBookingPolicyConfig(ctx.providers.repository);
    const readModel = await loadBookingWithLatestPayment({
      booking,
    }, {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      operation: ctx.operation,
      siteUrl: ctx.siteUrl,
    });
    const event = booking.event_id ? await ctx.providers.repository.getEventById(booking.event_id) : null;
    const payment = readModel.payment;
    const refundStatus = effectiveRefundStatus(payment);
    const refund = refundStatus !== 'NONE'
      ? {
          status: refundStatus,
          invoiceUrl: payment?.invoice_url ?? null,
          receiptUrl: payment?.stripe_receipt_url ?? null,
          creditNoteUrl: payment?.stripe_credit_note_url ?? null,
        }
      : null;
    const paymentDueAt = new Date(
      new Date(booking.starts_at).getTime() - bookingPolicy.paymentDueBeforeStartHours * 60 * 60 * 1000,
    ).toISOString();
    const policy = evaluateManageBookingPolicy(booking.starts_at, bookingPolicy.selfServiceLockWindowHours);
    const actions = await resolveManageActionState({
      booking,
      payment,
      bypassPolicyWindow: access.bypassPolicyWindow,
      canSelfServeChange: policy.canSelfServeChange,
      siteUrl: ctx.siteUrl,
    });
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'manage_booking_actions_gate_decision',
      message: 'Computed manage-booking actions',
      context: {
        path,
        booking_id: booking.id,
        booking_status: booking.current_status,
        booking_source: actions.source,
        starts_at: booking.starts_at,
        hours_before_start: policy.hoursBeforeStart,
        paid: actions.isPaid,
        actor_source: access.actorSource,
        policy_bypass_applied: access.bypassPolicyWindow,
        can_reschedule: actions.canReschedule,
        can_cancel: actions.canCancel,
        can_complete_payment: actions.canCompletePayment,
        has_continue_payment_url: Boolean(actions.continuePaymentUrl),
        has_calendar_event: Boolean(buildPublicCalendarEventInfo(booking, event)),
        calendar_sync_pending_retry: isSessionCalendarSyncPendingRetry(booking),
        branch_taken: 'return_manage_booking_payload',
      },
    });
    const paymentMethod = booking.event_id && booking.booking_type === 'PAY_LATER' && payment?.status === 'CASH_OK'
      ? 'pay_at_event'
      : booking.booking_type === 'PAY_NOW'
        ? 'pay_now'
        : booking.booking_type === 'PAY_LATER'
          ? 'pay_later'
          : 'free';
    const paymentMethodLabel = paymentMethod === 'pay_at_event'
      ? 'Pay at the event'
      : paymentMethod === 'pay_now'
        ? 'Pay now'
        : paymentMethod === 'pay_later'
          ? 'Pay later'
          : 'Free';
    const paymentMethodMessage = paymentMethod === 'pay_at_event'
      ? 'No online payment is required now. Your place will be confirmed after email confirmation.'
      : null;

    return ok({
      booking_id: booking.id,
      source: actions.source,
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
        can_reschedule: actions.canReschedule,
        can_cancel: actions.canCancel,
        can_complete_payment: actions.canCompletePayment,
        continue_payment_url: actions.continuePaymentUrl,
      },
      is_paid: actions.isPaid,
      payment_method: paymentMethod,
      payment_method_label: paymentMethodLabel,
      payment_method_message: paymentMethodMessage,
      payment_status: payment?.status ?? null,
      refund,
      payment_due_at: paymentMethod === 'pay_at_event' ? null : (payment ? paymentDueAt : null),
      policy: {
        text: getBookingPolicyText(bookingPolicy.selfServiceLockWindowHours),
        can_self_serve_change: access.bypassPolicyWindow ? true : policy.canSelfServeChange,
        lock_window_hours: bookingPolicy.selfServiceLockWindowHours,
        locked_message: `This session starts in less than ${bookingPolicy.selfServiceLockWindowHours} hours.\nAccording to the booking policy:\n• cancellations are not refundable\n• rescheduling is no longer available online\nIf you have an emergency, please contact Yair directly.`,
      },
      event: event
        ? {
            id: event.id,
            slug: event.slug,
            title: event.title,
            starts_at: event.starts_at,
          }
        : null,
      calendar_event: buildPublicCalendarEventInfo(booking, event),
      calendar_sync_pending_retry: isSessionCalendarSyncPendingRetry(booking),
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
    throw err;
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
