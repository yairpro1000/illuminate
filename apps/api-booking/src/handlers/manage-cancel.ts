import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { resolveBookingByManageToken, cancelBooking } from '../services/booking-service.js';

// POST /api/bookings/cancel
// Body: { token: string }
export async function handleManageCancel(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;
    const token = body['token'] as string | undefined;
    if (!token) throw badRequest('token is required');

    const booking = await resolveBookingByManageToken(token, ctx.providers.repository);
    await cancelBooking(booking, {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
    });

    return ok({ booking_id: booking.id, status: 'CANCELED' });
  } catch (err) {
    return errorResponse(err);
  }
}
