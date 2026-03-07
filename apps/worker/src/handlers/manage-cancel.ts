import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { resolveBookingByManageToken, cancelBooking } from '../services/booking-service.js';
import { resolveRegistrationByManageToken, cancelRegistration } from '../services/registration-service.js';

// POST /api/manage/cancel
// Body: { type: 'booking'|'registration', token: string, id: string }
export async function handleManageCancel(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const body  = await request.json() as Record<string, unknown>;
    const type  = body['type']  as string | undefined;
    const token = body['token'] as string | undefined;
    const id    = body['id']    as string | undefined;

    if (!type || !token || !id) throw badRequest('type, token, and id are required');

    const svcCtx = { providers: ctx.providers, env: ctx.env, logger: ctx.logger, requestId: ctx.requestId };

    if (type === 'booking') {
      const booking = await resolveBookingByManageToken(token, id, ctx.providers.repository);
      await cancelBooking(booking, svcCtx);
      return ok({ ok: true, status: 'cancelled' });
    }

    if (type === 'registration') {
      const reg = await resolveRegistrationByManageToken(token, id, ctx.providers.repository);
      await cancelRegistration(reg, svcCtx);
      return ok({ ok: true, status: 'cancelled' });
    }

    throw badRequest('type must be booking or registration');
  } catch (err) {
    return errorResponse(err);
  }
}
