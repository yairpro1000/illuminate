import type { AppContext } from '../router.js';
import { ok, badRequest } from '../lib/errors.js';
import { resolveLatestMockEmailPreviewForBooking } from '../lib/mock-email-preview.js';
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
  const mockEmailPreview = resolveLatestMockEmailPreviewForBooking(booking.id, {
    emailMode: ctx.env.EMAIL_MODE,
    apiOrigin: url.origin,
  }, {
    emailKinds: ['booking_confirmation', 'event_confirmation'],
  });
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_confirm_mock_email_preview_decision',
    message: 'Evaluated inline mock email preview for booking confirmation result',
    context: {
      booking_id: booking.id,
      booking_status: booking.current_status,
      email_mode: ctx.env.EMAIL_MODE,
      has_mock_email_preview: Boolean(mockEmailPreview),
      branch_taken: ctx.env.EMAIL_MODE !== 'mock'
        ? 'skip_mock_email_preview_email_mode_not_mock'
        : mockEmailPreview
          ? 'include_mock_email_preview'
          : 'skip_mock_email_preview_captured_email_missing',
      deny_reason: ctx.env.EMAIL_MODE !== 'mock'
        ? 'email_mode_not_mock'
        : mockEmailPreview
          ? null
          : 'captured_email_not_found_for_booking',
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
    ...(mockEmailPreview ? { mock_email_preview: mockEmailPreview } : {}),
  });
}
