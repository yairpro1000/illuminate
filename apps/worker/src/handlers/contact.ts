import type { AppContext } from '../router.js';
import { EmailProviderError } from '../providers/email/interface.js';
import { ApiError, ok, badRequest, jsonResponse } from '../lib/errors.js';

// POST /api/contact
export async function handleContact(request: Request, ctx: AppContext): Promise<Response> {
  const trace: Array<{ step: string; ok: boolean; detail?: unknown }> = [];

  try {
    trace.push({ step: 'parse_json', ok: true });
    const body = await request.json() as Record<string, unknown>;

    trace.push({ step: 'validate_payload', ok: true });
    const name = requireString(body, 'name');
    const email = requireString(body, 'email');
    const message = requireString(body, 'message');

    trace.push({ step: 'verify_antibot', ok: true, detail: { hasToken: Boolean(body['turnstile_token']) } });
    await ctx.providers.antibot.verify(
      (body['turnstile_token'] as string | undefined) ?? '',
      request.headers.get('CF-Connecting-IP'),
    );

    trace.push({ step: 'send_contact_email:start', ok: true });
    const sendResult = await ctx.providers.email.sendContactMessage(name, email, message);
    trace.push({
      step: 'send_contact_email:done',
      ok: true,
      detail: {
        messageId: sendResult.messageId,
        providerDebug: sendResult.debug ?? null,
      },
    });

    ctx.logger.info('contact message sent', { from: email });
    return ok({
      ok: true,
      message_id: sendResult.messageId,
      trace,
    });
  } catch (err) {
    const providerDebug = err instanceof EmailProviderError ? err.debug : undefined;
    trace.push({
      step: 'failed',
      ok: false,
      detail: {
        error: err instanceof Error ? err.message : String(err),
        providerDebug: providerDebug ?? null,
      },
    });

    ctx.logger.error('contact message failed', {
      err: String(err),
      trace,
      providerDebug: providerDebug ?? null,
    });

    try {
      await ctx.providers.repository.logFailure({
        source: 'email',
        operation: 'sendContactMessage',
        request_id: ctx.requestId,
        error_message: String(err),
        context: { trace, providerDebug: providerDebug ?? null },
      });
    } catch (logErr) {
      ctx.logger.error('failed to persist contact failure log', { err: String(logErr) });
    }

    if (err instanceof ApiError) {
      return jsonResponse({
        ok: false,
        error: err.code,
        message: err.message,
        trace,
      }, err.statusCode);
    }

    return jsonResponse({
      ok: false,
      error: 'CONTACT_SEND_FAILED',
      message: err instanceof Error ? err.message : String(err),
      trace,
    }, 500);
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${key} is required`);
  return v.trim();
}
