import type { AppContext } from '../router.js';
import { EmailProviderError } from '../providers/email/interface.js';
import { ApiError, ok, badRequest, jsonResponse } from '../lib/errors.js';
import { sanitizeContext } from '../../../shared/observability/backend.js';

// POST /api/contact
export async function handleContact(request: Request, ctx: AppContext): Promise<Response> {
  ctx.logger.logMilestone('incoming_request_received', { flow: 'contact_form' });

  try {
    const body = await request.json() as Record<string, unknown>;

    const { firstName, lastName, name } = resolveContactName(body);
    const email = requireString(body, 'email');
    const message = requireString(body, 'message');
    const topic = typeof body['topic'] === 'string' && body['topic'].trim() ? body['topic'].trim() : null;

    await ctx.providers.antibot.verify(
      (body['turnstile_token'] as string | undefined) ?? '',
      request.headers.get('CF-Connecting-IP'),
    );

    const normalizedEmail = email.trim().toLowerCase();
    const existingClient = await ctx.providers.repository.getClientByEmail(normalizedEmail);
    const client = existingClient
      ? await ctx.providers.repository.updateClient(existingClient.id, {
          first_name: firstName,
          last_name: lastName,
          email: normalizedEmail,
        })
      : await ctx.providers.repository.createClient({
          first_name: firstName,
          last_name: lastName,
          email: normalizedEmail,
          phone: null,
        });

    const contact = await ctx.providers.repository.createContactMessage({
      client_id: client.id,
      first_name: firstName,
      last_name: lastName,
      email: normalizedEmail,
      topic,
      message,
      status: 'new',
      source: 'website_contact_form',
    });

    const sendResult = await ctx.providers.email.sendContactMessage(name, normalizedEmail, message, topic);

    ctx.logger.logMilestone('provider_result_persisted', {
      flow: 'contact_form',
      provider: 'email',
      message_id: sendResult.messageId,
      contact_message_id: contact.id,
      client_id: client.id,
    });

    return ok({ ok: true, message_id: sendResult.messageId, contact_id: contact.id, request_id: ctx.requestId });
  } catch (err) {
    const providerDebug = err instanceof EmailProviderError ? err.debug : undefined;

    try {
      await ctx.providers.repository.logFailure({
        source: 'email',
        operation: 'sendContactMessage',
        request_id: ctx.requestId,
        error_message: String(err),
        context: sanitizeContext({
          flow: 'contact_form',
          provider: typeof providerDebug?.['provider'] === 'string' ? providerDebug['provider'] : null,
          kind: typeof providerDebug?.['kind'] === 'string' ? providerDebug['kind'] : null,
        }),
      });
    } catch (logErr) {
      ctx.logger.error('failed to persist contact failure log', { err: String(logErr) });
    }

    if (err instanceof ApiError) {
      return jsonResponse({ ok: false, error: err.code, message: err.message, request_id: ctx.requestId }, err.statusCode);
    }

    return jsonResponse({
      ok: false,
      error: 'CONTACT_SEND_FAILED',
      message: 'Could not send your message right now.',
      request_id: ctx.requestId,
    }, 500);
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${key} is required`);
  return v.trim();
}

function resolveContactName(body: Record<string, unknown>): { firstName: string; lastName: string | null; name: string } {
  const firstName = typeof body['first_name'] === 'string' ? body['first_name'].trim() : '';
  const lastName = typeof body['last_name'] === 'string' ? body['last_name'].trim() || null : null;
  if (firstName) {
    const name = [firstName, lastName ?? ''].filter(Boolean).join(' ');
    return { firstName, lastName, name };
  }

  const fullName = requireString(body, 'name');
  const [first, ...rest] = fullName.split(/\s+/g);
  return {
    firstName: first ?? fullName,
    lastName: rest.length ? rest.join(' ') : null,
    name: fullName,
  };
}
