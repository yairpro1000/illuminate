import type { AppContext } from '../router.js';
import { ok, badRequest } from '../lib/errors.js';
import { consumeLatestEmailDispatch } from '../lib/execution.js';
import { confirmBookingEmailResult } from '../services/booking-service.js';

// GET /api/bookings/confirm?token=<raw>
export async function handleConfirm(request: Request, ctx: AppContext): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'booking_confirm_request_denied',
      message: 'Denied booking confirmation request because token is missing',
      context: {
        method: request.method,
        path: url.pathname,
        has_token: false,
        branch_taken: 'deny_missing_confirm_token',
        deny_reason: 'confirm_token_missing',
      },
    });
    throw badRequest('token is required');
  }
  const confirmation = await confirmBookingEmailResult(token, {
    providers: ctx.providers,
    env: ctx.env,
    logger: ctx.logger,
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    operation: ctx.operation,
    siteUrl: ctx.siteUrl,
  });
  const booking = confirmation.booking;
  const actionInfo = confirmation.actionInfo;
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_confirm_token_redemption_completed',
    message: 'Completed booking confirmation token redemption',
    context: {
      booking_id: booking.id,
      booking_status: booking.current_status,
      booking_kind: booking.event_id ? 'event' : 'session',
      booking_type: booking.booking_type,
      branch_taken: 'booking_confirmation_redeemed',
      deny_reason: null,
    },
  });
  const emailDispatch = consumeLatestEmailDispatch(ctx.operation);
  const mockEmailPreview = emailDispatch?.mockEmailPreview ?? null;
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_confirm_mock_email_preview_decision',
    message: 'Evaluated inline mock email preview for booking confirmation result',
    context: {
      booking_id: booking.id,
      booking_status: booking.current_status,
      email_mode: ctx.env.EMAIL_MODE,
      ui_test_mode: emailDispatch?.uiTestMode ?? null,
      has_mock_email_preview: Boolean(mockEmailPreview),
      email_kind: emailDispatch?.emailKind ?? null,
      branch_taken: emailDispatch?.branchTaken ?? 'skip_mock_email_preview_email_not_dispatched',
      deny_reason: emailDispatch?.denyReason ?? 'email_not_dispatched_in_request',
    },
  });

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_confirm_request_completed',
    message: 'Completed booking confirmation request handling',
    context: {
      booking_id: booking.id,
      booking_status: booking.current_status,
      booking_kind: booking.event_id ? 'event' : 'session',
      has_checkout_url: Boolean(actionInfo.checkoutUrl),
      has_manage_url: Boolean(actionInfo.manageUrl),
      has_mock_email_preview: Boolean(mockEmailPreview),
      branch_taken: 'return_booking_confirmation_response',
      deny_reason: null,
    },
  });

  return ok({
    booking_id: booking.id,
    status: booking.current_status,
    source: booking.event_id ? 'event' : 'session',
    checkout_url: actionInfo.checkoutUrl,
    manage_url: actionInfo.manageUrl,
    next_action_url: actionInfo.nextActionUrl,
    next_action_label: actionInfo.nextActionLabel,
    calendar_event: actionInfo.calendarEvent,
    calendar_sync_pending_retry: actionInfo.calendarSyncPendingRetry,
    ...(mockEmailPreview ? { mock_email_preview: mockEmailPreview } : {}),
  });
}
