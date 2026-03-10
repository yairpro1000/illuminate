import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { resolveBookingByManageToken } from '../services/booking-service.js';

// GET /api/bookings/manage?token=<raw>
export async function handleManageInfo(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!token) throw badRequest('token is required');

    const booking = await resolveBookingByManageToken(token, ctx.providers.repository);
    const event = booking.event_id ? await ctx.providers.repository.getEventById(booking.event_id) : null;

    const source = booking.event_id ? 'event' : 'session';
    const canReschedule = source === 'session' && !['EXPIRED', 'CANCELED', 'CLOSED'].includes(booking.current_status);
    const canCancel = !['EXPIRED', 'CANCELED', 'CLOSED'].includes(booking.current_status);

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
    return errorResponse(err);
  }
}
