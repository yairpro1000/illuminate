import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { resolveBookingByManageToken } from '../services/booking-service.js';
import { resolveRegistrationByManageToken } from '../services/registration-service.js';

// GET /api/manage?type=booking|registration&token=<raw>&id=<uuid>
export async function handleManageInfo(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const url   = new URL(request.url);
    const type  = url.searchParams.get('type');
    const token = url.searchParams.get('token');
    const id    = url.searchParams.get('id');

    if (!type || !token || !id) throw badRequest('type, token, and id are required');

    if (type === 'booking') {
      const booking = await resolveBookingByManageToken(token, id, ctx.providers.repository);
      return ok({
        type: 'booking',
        id: booking.id,
        status: booking.status,
        starts_at: booking.starts_at,
        ends_at: booking.ends_at,
        client_name: booking.client_name,
        client_email: booking.client_email,
        address_line: booking.address_line,
        maps_url: booking.maps_url,
        payment_due_at: booking.payment_due_at,
        google_event_id: booking.google_event_id,
      });
    }

    if (type === 'registration') {
      const reg = await resolveRegistrationByManageToken(token, id, ctx.providers.repository);
      const attendees = await ctx.providers.repository.getAttendeesByRegistrationId(reg.id);
      const event = await ctx.providers.repository.getEventById(reg.event_id);

      return ok({
        type: 'registration',
        id: reg.id,
        status: reg.status,
        event_id: reg.event_id,
        event_title: event?.title ?? null,
        event_starts_at: event?.starts_at ?? null,
        primary_name: reg.primary_name,
        primary_email: reg.primary_email,
        attendee_count: reg.attendee_count,
        attendees: attendees.map((a) => a.full_name),
      });
    }

    throw badRequest('type must be booking or registration');
  } catch (err) {
    return errorResponse(err);
  }
}
