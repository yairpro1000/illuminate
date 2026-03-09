import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { resolveBookingByManageToken, rescheduleBooking } from '../services/booking-service.js';

// POST /api/bookings/reschedule
// Body: { token: string, new_start: string, new_end: string, timezone?: string }
export async function handleManageReschedule(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;
    const token = body['token'] as string | undefined;
    const newStart = body['new_start'] as string | undefined;
    const newEnd = body['new_end'] as string | undefined;

    if (!token || !newStart || !newEnd) {
      throw badRequest('token, new_start, and new_end are required');
    }

    const booking = await resolveBookingByManageToken(token, ctx.providers.repository);
    const updated = await rescheduleBooking(
      booking,
      {
        newStart,
        newEnd,
        timezone: (body['timezone'] as string | undefined) ?? booking.timezone,
      },
      {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
      },
    );

    return ok({
      booking_id: updated.id,
      status: updated.status,
      starts_at: updated.starts_at,
      ends_at: updated.ends_at,
      timezone: updated.timezone,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
