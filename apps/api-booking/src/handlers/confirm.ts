import type { AppContext } from '../router.js';
import { ok, badRequest } from '../lib/errors.js';
import { consumeLatestEmailDispatch } from '../lib/execution.js';
import { confirmBookingEmail, getBookingPublicActionInfo } from '../services/booking-service.js';

// GET /api/bookings/confirm?token=<raw>
export async function handleConfirm(request: Request, ctx: AppContext): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) throw badRequest('token is required');

  const booking = await confirmBookingEmail(token, {
    providers: ctx.providers,
    env: ctx.env,
    logger: ctx.logger,
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    operation: ctx.operation,
  });
  const actionInfo = await getBookingPublicActionInfo(booking, {
    providers: ctx.providers,
    env: ctx.env,
    logger: ctx.logger,
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    operation: ctx.operation,
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
