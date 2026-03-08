import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';

// POST /api/contact
export async function handleContact(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const body = await request.json() as Record<string, unknown>;

    const name = requireString(body, 'name');
    const email = requireString(body, 'email');
    const message = requireString(body, 'message');

    await ctx.providers.antibot.verify(
      (body['turnstile_token'] as string | undefined) ?? '',
      request.headers.get('CF-Connecting-IP'),
    );

    await ctx.providers.email.sendContactMessage(name, email, message);

    ctx.logger.info('contact message sent', { from: email });
    return ok({ ok: true });
  } catch (err) {
    ctx.logger.error('contact message failed', { err: String(err) });

    try {
      await ctx.providers.repository.logFailure({
        source: 'email',
        operation: 'sendContactMessage',
        request_id: ctx.requestId,
        error_message: String(err),
      });
    } catch (logErr) {
      ctx.logger.error('failed to persist contact failure log', { err: String(logErr) });
    }

    return errorResponse(err);
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${key} is required`);
  return v.trim();
}
