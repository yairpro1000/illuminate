import type { AppContext } from '../router.js';
import { ok, badRequest } from '../lib/errors.js';
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

  return ok({
    booking_id: actionInfo.booking.id,
    status: actionInfo.booking.current_status,
    source: actionInfo.booking.event_id ? 'event' : 'session',
    checkout_url: actionInfo.checkoutUrl,
    manage_url: actionInfo.manageUrl,
    next_action_url: actionInfo.nextActionUrl,
    next_action_label: actionInfo.nextActionLabel,
  });
}
