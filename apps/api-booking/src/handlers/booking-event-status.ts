import type { AppContext } from '../router.js';
import { badRequest, ok } from '../lib/errors.js';
import { getBookingEventStatusSnapshot } from '../services/booking-service.js';

export async function handleBookingEventStatus(request: Request, ctx: AppContext): Promise<Response> {
  const url = new URL(request.url);
  const bookingEventId = url.searchParams.get('booking_event_id');
  const token = url.searchParams.get('token');
  const adminToken = url.searchParams.get('admin_token');

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_event_status_request_decision',
    message: 'Evaluated booking event status request parameters',
    context: {
      booking_event_id: bookingEventId,
      has_token: Boolean(token),
      has_admin_token: Boolean(adminToken),
      branch_taken: bookingEventId && token ? 'allow_booking_event_status_lookup' : 'deny_missing_required_query',
      deny_reason: bookingEventId && token ? null : 'booking_event_id_or_token_missing',
    },
  });

  if (!bookingEventId || !token) {
    throw badRequest('booking_event_id and token are required');
  }

  const snapshot = await getBookingEventStatusSnapshot(
    bookingEventId,
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
      branch_taken: 'return_booking_event_status_snapshot',
      deny_reason: null,
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
    refund: snapshot.refund,
  });
}
