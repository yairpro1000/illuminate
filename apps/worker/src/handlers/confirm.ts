import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { confirmBookingEmail } from '../services/booking-service.js';
import { confirmRegistrationEmail } from '../services/registration-service.js';

// GET /api/confirm?type=booking|registration&token=<raw>&id=<uuid>
export async function handleConfirm(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const url   = new URL(request.url);
    const type  = url.searchParams.get('type');
    const token = url.searchParams.get('token');
    const id    = url.searchParams.get('id');

    if (!type || !token || !id) throw badRequest('type, token, and id are required');

    const svcCtx = { providers: ctx.providers, env: ctx.env, logger: ctx.logger, requestId: ctx.requestId };

    if (type === 'booking') {
      const booking = await confirmBookingEmail(token, id, svcCtx);
      return ok({ ok: true, booking_id: booking.id, status: booking.status });
    }

    if (type === 'registration') {
      const reg = await confirmRegistrationEmail(token, id, svcCtx);
      return ok({ ok: true, registration_id: reg.id, status: reg.status });
    }

    throw badRequest('type must be booking or registration');
  } catch (err) {
    return errorResponse(err);
  }
}
