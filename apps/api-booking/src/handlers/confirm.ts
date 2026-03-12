import type { AppContext } from '../router.js';
import { ok, badRequest } from '../lib/errors.js';
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

  return ok({
    booking_id: booking.id,
    status: booking.current_status,
    source: booking.event_id ? 'event' : 'session',
    checkout_url: actionInfo.checkoutUrl,
    manage_url: actionInfo.manageUrl,
    next_action_url: actionInfo.nextActionUrl,
    next_action_label: actionInfo.nextActionLabel,
  });
}
