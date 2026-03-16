import type { AppContext } from '../router.js';
import { ok, badRequest } from '../lib/errors.js';
import { getMockEmailPreviewDecision, resolveLatestMockEmailPreviewForBooking } from '../lib/mock-email-preview.js';
import { getBookingPublicActionInfoByPaymentSession } from '../services/booking-service.js';

// GET /api/bookings/payment-status?session_id=<provider-session-id>
export async function handlePaymentStatus(request: Request, ctx: AppContext): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) throw badRequest('session_id is required');

  const actionInfo = await getBookingPublicActionInfoByPaymentSession(sessionId, {
    providers: ctx.providers,
    env: ctx.env,
    logger: ctx.logger,
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    operation: ctx.operation,
  });
  const previewDecision = getMockEmailPreviewDecision(ctx.env.EMAIL_MODE, request);
  const mockEmailPreview = resolveLatestMockEmailPreviewForBooking(actionInfo.booking.id, {
    emailMode: ctx.env.EMAIL_MODE,
    apiOrigin: url.origin,
    uiTestMode: previewDecision.uiTestMode,
  }, {
    emailKinds: ['booking_confirmation', 'event_confirmation'],
  });
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'payment_status_mock_email_preview_decision',
    message: 'Evaluated inline mock email preview for payment status recovery',
    context: {
      booking_id: actionInfo.booking.id,
      session_id: sessionId,
      booking_status: actionInfo.booking.current_status,
      email_mode: ctx.env.EMAIL_MODE,
      ui_test_mode: previewDecision.uiTestMode,
      has_mock_email_preview: Boolean(mockEmailPreview),
      branch_taken: !previewDecision.shouldExpose
        ? previewDecision.branchTaken
        : mockEmailPreview
          ? 'include_mock_email_preview'
          : 'skip_mock_email_preview_captured_email_missing',
      deny_reason: !previewDecision.shouldExpose
        ? previewDecision.denyReason
        : mockEmailPreview
          ? null
          : 'captured_email_not_found_for_booking',
    },
  });

  return ok({
    booking_id: actionInfo.booking.id,
    status: actionInfo.booking.current_status,
    source: actionInfo.booking.event_id ? 'event' : 'session',
    checkout_url: actionInfo.checkoutUrl,
    manage_url: actionInfo.manageUrl,
    next_action_url: actionInfo.nextActionUrl,
    next_action_label: actionInfo.nextActionLabel,
    calendar_event: actionInfo.calendarEvent,
    calendar_sync_pending_retry: actionInfo.calendarSyncPendingRetry,
    ...(mockEmailPreview ? { mock_email_preview: mockEmailPreview } : {}),
  });
}
