import { describe, expect, it, vi } from 'vitest';
import { handleContact } from '../src/handlers/contact.js';
import { handleRequest } from '../src/router.js';
import { EmailProviderError } from '../src/providers/email/interface.js';
import { makeCtx } from './admin-helpers.js';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://api.local/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
    body: JSON.stringify(body),
  });
}

describe('handleContact', () => {
  it('returns success when contact is stored and email sends', async () => {
    const repository = {
      getClientByEmail: vi.fn().mockResolvedValue(null),
      createClient: vi.fn().mockResolvedValue({ id: 'client-1' }),
      createContactMessage: vi.fn().mockResolvedValue({ id: 'contact-1' }),
    };
    const email = {
      sendContactMessage: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
    };
    const antibot = {
      verify: vi.fn().mockResolvedValue(undefined),
    };
    const logger = {
      logMilestone: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
      captureException: vi.fn(),
    };
    const ctx = makeCtx({ providers: { repository, email, antibot }, logger, requestId: 'req-contact-ok' });

    const response = await handleContact(makeRequest({
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      topic: 'sessions',
      message: 'Hello there',
      turnstile_token: 'ok',
    }), ctx);

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toEqual({
      ok: true,
      message_id: 'msg-1',
      contact_id: 'contact-1',
      email_delivery: 'sent',
      request_id: 'req-contact-ok',
    });
    expect(repository.createContactMessage).toHaveBeenCalledWith({
      client_id: 'client-1',
      topic: 'sessions',
      message: 'Hello there',
      status: 'NEW',
      source: 'WEBSITE_CONTACT_FORM',
    });
    expect(logger.logWarn).not.toHaveBeenCalled();
    expect(logger.logError).not.toHaveBeenCalled();
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('returns success with failed email_delivery when email provider fails after persistence', async () => {
    const repository = {
      getClientByEmail: vi.fn().mockResolvedValue(null),
      createClient: vi.fn().mockResolvedValue({ id: 'client-2' }),
      createContactMessage: vi.fn().mockResolvedValue({ id: 'contact-2' }),
    };
    const email = {
      sendContactMessage: vi.fn().mockRejectedValue(new EmailProviderError('provider down', {
        provider: 'resend',
        kind: 'contact_message',
      })),
    };
    const antibot = {
      verify: vi.fn().mockResolvedValue(undefined),
    };
    const logger = {
      logMilestone: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
      captureException: vi.fn(),
    };
    const ctx = makeCtx({ providers: { repository, email, antibot }, logger, requestId: 'req-contact-email-fail' });

    const response = await handleContact(makeRequest({
      first_name: 'Grace',
      email: 'grace@example.com',
      message: 'Need more info',
      turnstile_token: 'ok',
    }), ctx);

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toEqual({
      ok: true,
      message_id: null,
      contact_id: 'contact-2',
      email_delivery: 'failed',
      request_id: 'req-contact-email-fail',
    });
    expect(repository.createContactMessage).toHaveBeenCalledWith({
      client_id: 'client-2',
      topic: null,
      message: 'Need more info',
      status: 'NEW',
      source: 'WEBSITE_CONTACT_FORM',
    });
    expect(logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'contact_email_send_failed_after_persist',
    }));
    expect(logger.logError).not.toHaveBeenCalled();
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('throws BAD_REQUEST and records wrapper diagnostics for invalid payload', async () => {
    const repository = {
      getClientByEmail: vi.fn(),
      createClient: vi.fn(),
      createContactMessage: vi.fn(),
    };
    const email = {
      sendContactMessage: vi.fn(),
    };
    const antibot = {
      verify: vi.fn(),
    };
    const logger = {
      logMilestone: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
      captureException: vi.fn(),
    };
    const ctx = makeCtx({ providers: { repository, email, antibot }, logger, requestId: 'req-contact-bad' });

    await expect(handleContact(makeRequest({
      first_name: 'NoEmail',
      message: 'missing email field',
      turnstile_token: 'ok',
    }), ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'email is required',
    });

    expect(ctx.operation.latestInboundErrorCode).toBe('BAD_REQUEST');
    expect(ctx.operation.latestInboundErrorMessage).toBe('email is required');
    expect(logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'contact_send_failed',
      context: expect.objectContaining({
        error_code: 'BAD_REQUEST',
        deny_reason: 'BAD_REQUEST',
        branch: 'input_or_policy_rejected',
      }),
    }));
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('uses the shared wrapper envelope for invalid contact payloads', async () => {
    const ctx = makeCtx({
      env: {
        SITE_URL: 'https://letsilluminate.co',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
      } as any,
      providers: {
        repository: {
          getClientByEmail: vi.fn(),
          createClient: vi.fn(),
          createContactMessage: vi.fn(),
        },
        email: {
          sendContactMessage: vi.fn(),
        },
        antibot: {
          verify: vi.fn(),
        },
      } as any,
      requestId: 'req-contact-wrapper',
    });

    const response = await handleRequest(new Request('https://api.local/api/contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://letsilluminate.co',
      },
      body: JSON.stringify({
        first_name: 'NoEmail',
        message: 'missing email field',
        turnstile_token: 'ok',
      }),
    }), ctx);

    expect(response.status).toBe(400);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      error: 'BAD_REQUEST',
      message: 'email is required',
      request_id: expect.any(String),
    }));
  });
});
