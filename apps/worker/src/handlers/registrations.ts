import type { AppContext } from '../router.js';
import { ok, notFound, badRequest, errorResponse } from '../lib/errors.js';
import { createFreeRegistration, createPaidRegistration } from '../services/registration-service.js';

// POST /api/events/:slug/register
export async function handleEventRegister(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const slug = params['slug'];
    if (!slug) throw notFound();

    const event = await ctx.providers.repository.getEventBySlug(slug);
    if (!event) throw notFound('Event not found');
    if (event.status !== 'published') throw badRequest('Event is not open for registration');

    // Check capacity (confirmed registrations only, per spec)
    if (event.capacity !== null) {
      const confirmed = await ctx.providers.repository.countConfirmedRegistrations(event.id);
      if (confirmed >= event.capacity) throw badRequest('Event is at capacity');
    }

    const body = await request.json() as Record<string, unknown>;

    const primaryName  = body['primary_name']  as string | undefined;
    const primaryEmail = body['primary_email'] as string | undefined;

    if (!primaryName?.trim() || !primaryEmail?.trim()) {
      throw badRequest('primary_name and primary_email are required');
    }

    const additionalAttendees = ((body['attendees'] as string[] | undefined) ?? [])
      .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      .slice(0, 4);

    const svcCtx = { providers: ctx.providers, env: ctx.env, logger: ctx.logger, requestId: ctx.requestId };

    if (!event.is_paid) {
      const primaryPhone = body['primary_phone'] as string | undefined;
      if (!primaryPhone?.trim()) throw badRequest('Phone number is required for free events');

      const result = await createFreeRegistration(
        {
          event,
          primaryName:          primaryName.trim(),
          primaryEmail:         primaryEmail.trim(),
          primaryPhone:         primaryPhone.trim(),
          additionalAttendees,
          reminderEmailOptIn:   Boolean(body['reminder_email_opt_in']),
          reminderWhatsappOptIn: Boolean(body['reminder_whatsapp_opt_in']),
          turnstileToken:       (body['turnstile_token'] as string) ?? '',
          remoteIp:             request.headers.get('CF-Connecting-IP'),
        },
        svcCtx,
      );
      return ok({ ok: true, registration_id: result.registrationId, status: result.status });
    }

    const result = await createPaidRegistration(
      {
        event,
        primaryName:          primaryName.trim(),
        primaryEmail:         primaryEmail.trim(),
        primaryPhone:         (body['primary_phone'] as string | null) ?? null,
        additionalAttendees,
        reminderEmailOptIn:   Boolean(body['reminder_email_opt_in']),
        reminderWhatsappOptIn: Boolean(body['reminder_whatsapp_opt_in']),
        turnstileToken:       (body['turnstile_token'] as string) ?? '',
        remoteIp:             request.headers.get('CF-Connecting-IP'),
      },
      svcCtx,
    );

    return ok({
      ok:                      true,
      registration_id:         result.registrationId,
      status:                  result.status,
      checkout_url:            result.checkoutUrl,
      checkout_hold_expires_at: result.checkoutHoldExpiresAt,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
