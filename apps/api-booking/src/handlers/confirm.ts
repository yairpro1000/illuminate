import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { confirmBookingEmail } from '../services/booking-service.js';

// GET /api/bookings/confirm?token=<raw>
export async function handleConfirm(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!token) throw badRequest('token is required');

    const booking = await confirmBookingEmail(token, {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
    });

    return ok({ booking_id: booking.id, status: booking.status, source: booking.source });
  } catch (err) {
    return errorResponse(err);
  }
}
