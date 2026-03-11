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
    const normalizedEmail = email.trim().toLowerCase();

    ctx.logger.logMilestone('contact_payload_validated', {
      flow: 'contact_form',
      has_topic: !!topic,
      has_last_name: !!lastName,
      email_domain: normalizedEmail.includes('@') ? (normalizedEmail.split('@')[1] ?? null) : null,
    });

    await ctx.providers.antibot.verify(
      (body['turnstile_token'] as string | undefined) ?? '',
      request.headers.get('CF-Connecting-IP'),
    );
    ctx.logger.logMilestone('contact_antibot_verification_passed', {
      flow: 'contact_form',
      provider: 'antibot',
    });

    const existingClient = await ctx.providers.repository.getClientByEmail(normalizedEmail);
    ctx.logger.logMilestone('contact_client_lookup_completed', {
      flow: 'contact_form',
      client_exists: !!existingClient,
    });
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
    ctx.logger.logMilestone('contact_client_upsert_completed', {
      flow: 'contact_form',
      branch: existingClient ? 'update_existing_client' : 'create_new_client',
      client_id: client.id,
    });

    const contact = await ctx.providers.repository.createContactMessage({
      client_id: client.id,
      topic,
      message,
      status: 'new',
      source: 'website_contact_form',
    });
    ctx.logger.logMilestone('contact_message_persisted', {
      flow: 'contact_form',
      contact_message_id: contact.id,
      client_id: client.id,
    });

    try {
      ctx.logger.logMilestone('contact_email_send_attempted', {
        flow: 'contact_form',
        provider: 'email',
        kind: 'contact_message',
      });
      const sendResult = await ctx.providers.email.sendContactMessage(name, normalizedEmail, message, topic);

      ctx.logger.logMilestone('provider_result_persisted', {
        flow: 'contact_form',
        provider: 'email',
        message_id: sendResult.messageId,
        contact_message_id: contact.id,
        client_id: client.id,
      });

      return ok({
        ok: true,
        message_id: sendResult.messageId,
        contact_id: contact.id,
        email_delivery: 'sent',
        request_id: ctx.requestId,
      });
    } catch (emailErr) {
      const providerDebug = emailErr instanceof EmailProviderError ? emailErr.debug : undefined;
      ctx.logger.logWarn({
        source: 'worker',
        eventType: 'contact_email_send_failed_after_persist',
        message: 'Contact form email failed after contact persistence; returning accepted response',
        context: sanitizeContext({
          flow: 'contact_form',
          request_id: ctx.requestId,
          contact_message_id: contact.id,
          client_id: client.id,
          provider: typeof providerDebug?.['provider'] === 'string' ? providerDebug['provider'] : null,
          kind: typeof providerDebug?.['kind'] === 'string' ? providerDebug['kind'] : null,
          failure_reason: emailErr instanceof Error ? emailErr.message : String(emailErr),
        }),
      });
      return ok({
        ok: true,
        message_id: null,
        contact_id: contact.id,
        email_delivery: 'failed',
        request_id: ctx.requestId,
      });
    }
  } catch (err) {
    const providerDebug = err instanceof EmailProviderError ? err.debug : undefined;
    ctx.logger.logError({
      source: 'worker',
      eventType: 'contact_send_failed',
      message: 'Contact form email send failed',
      context: sanitizeContext({
        flow: 'contact_form',
        request_id: ctx.requestId,
        provider: typeof providerDebug?.['provider'] === 'string' ? providerDebug['provider'] : null,
        kind: typeof providerDebug?.['kind'] === 'string' ? providerDebug['kind'] : null,
        branch: err instanceof ApiError ? 'input_or_policy_rejected' : 'contact_handler_failed',
        error: String(err),
      }),
    });

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
