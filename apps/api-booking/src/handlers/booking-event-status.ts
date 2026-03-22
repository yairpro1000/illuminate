import type { AppContext } from '../router.js';
import { badRequest, ok } from '../lib/errors.js';
import { getBookingEventStatusSnapshot } from '../services/booking-public-action-service.js';
import { getMockEmailPreviewDecision, resolveLatestMockEmailPreviewForBooking } from '../lib/mock-email-preview.js';
import type { BookingEventType } from '../types.js';

export async function handleBookingEventStatus(request: Request, ctx: AppContext): Promise<Response> {
  const url = new URL(request.url);
  const bookingEventId = url.searchParams.get('booking_event_id');
  const bookingId = url.searchParams.get('booking_id');
  const bookingEventType = url.searchParams.get('booking_event_type');
  const token = url.searchParams.get('token');
  const adminToken = url.searchParams.get('admin_token');
  const selectorMode = bookingEventId
    ? 'by_id'
    : bookingId && bookingEventType
      ? 'latest_of_type'
      : 'missing_required_query';
  const shouldLookupById = selectorMode === 'by_id';
  const shouldLookupLatestOfType = selectorMode === 'latest_of_type';

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_event_status_request_decision',
    message: 'Evaluated booking event status request parameters',
    context: {
      booking_event_id: bookingEventId,
      booking_id: bookingId,
      booking_event_type: bookingEventType,
      has_token: Boolean(token),
      has_admin_token: Boolean(adminToken),
      selector_mode: selectorMode,
      branch_taken: token && (shouldLookupById || shouldLookupLatestOfType)
        ? shouldLookupById
          ? 'allow_booking_event_status_lookup_by_id'
          : 'allow_booking_event_status_lookup_by_booking_and_type'
        : 'deny_missing_required_query',
      deny_reason: token && (shouldLookupById || shouldLookupLatestOfType)
        ? null
        : 'booking_event_selector_or_token_missing',
    },
  });

  if (!token || (!shouldLookupById && !shouldLookupLatestOfType)) {
    throw badRequest('token plus either booking_event_id or booking_id and booking_event_type are required');
  }

  const snapshot = await getBookingEventStatusSnapshot(
    shouldLookupById
      ? { mode: 'by_id', bookingEventId: String(bookingEventId) }
      : {
          mode: 'latest_of_type',
          bookingId: String(bookingId),
          eventType: String(bookingEventType) as BookingEventType,
        },
    token,
    adminToken,
    {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      operation: ctx.operation,
      siteUrl: ctx.siteUrl,
    },
  );
  const previewDecision = getMockEmailPreviewDecision(ctx.env.EMAIL_MODE, request);
  const mockEmailPreview = resolveLatestMockEmailPreviewForBooking(snapshot.booking.id, {
    emailMode: ctx.env.EMAIL_MODE,
    apiOrigin: url.origin,
    uiTestMode: previewDecision.uiTestMode,
  }, {
    emailKinds: previewEmailKindsForEventType(snapshot.event.event_type),
  });

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_event_status_request_completed',
    message: 'Resolved booking event status snapshot',
    context: {
      booking_event_id: snapshot.event.id,
      booking_id: snapshot.booking.id,
      booking_event_type: snapshot.event.event_type,
      booking_event_status: snapshot.event.status,
      booking_status: snapshot.booking.current_status,
      is_terminal: snapshot.isTerminal,
      has_checkout_url: Boolean(snapshot.checkoutUrl),
      has_refund: Boolean(snapshot.refund),
      has_manage_url: Boolean(snapshot.manageUrl),
      has_mock_email_preview: Boolean(mockEmailPreview),
      selector_mode: selectorMode,
      branch_taken: 'return_booking_event_status_snapshot',
      deny_reason: null,
    },
  });
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_event_status_mock_email_preview_decision',
    message: 'Evaluated inline mock email preview for booking-event status',
    context: {
      booking_id: snapshot.booking.id,
      booking_event_id: snapshot.event.id,
      booking_event_type: snapshot.event.event_type,
      email_mode: ctx.env.EMAIL_MODE,
      ui_test_mode: previewDecision.uiTestMode,
      has_mock_email_preview: Boolean(mockEmailPreview),
      selector_mode: selectorMode,
      branch_taken: !previewDecision.shouldExpose
        ? previewDecision.branchTaken
        : mockEmailPreview
          ? 'include_mock_email_preview'
          : 'skip_mock_email_preview_captured_email_missing',
      deny_reason: !previewDecision.shouldExpose
        ? previewDecision.denyReason
        : mockEmailPreview
          ? null
          : 'captured_email_not_found_for_booking_and_event_type',
    },
  });

  return ok({
    booking_event_id: snapshot.event.id,
    booking_event_type: snapshot.event.event_type,
    booking_event_status: snapshot.event.status,
    booking_id: snapshot.booking.id,
    booking_status: snapshot.booking.current_status,
    is_terminal: snapshot.isTerminal,
    message: snapshot.message,
    checkout_url: snapshot.checkoutUrl,
    manage_url: snapshot.manageUrl,
    next_action_url: snapshot.nextActionUrl,
    next_action_label: snapshot.nextActionLabel,
    calendar_event: snapshot.calendarEvent,
    calendar_sync_pending_retry: snapshot.calendarSyncPendingRetry,
    refund: snapshot.refund,
    ...(mockEmailPreview ? { mock_email_preview: mockEmailPreview } : {}),
  });
}

function previewEmailKindsForEventType(eventType: BookingEventType): string[] {
  switch (eventType) {
    case 'PAYMENT_SETTLED':
      return ['booking_confirmation', 'event_confirmation'];
    case 'BOOKING_CANCELED':
      return ['booking_cancellation', 'booking_refund_confirmation'];
    default:
      return [];
  }
}
