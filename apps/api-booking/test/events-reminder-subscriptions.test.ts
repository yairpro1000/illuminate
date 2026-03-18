import { describe, expect, it, vi } from 'vitest';

import { handleRequest } from '../src/router.js';
import { makeCtx } from './admin-helpers.js';

function makeRequest(body: Record<string, unknown>, extraHeaders?: Record<string, string>): Request {
  return new Request('https://api.local/api/events/reminder-subscriptions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
  });
}

describe('public reminder subscriptions', () => {
  it('rejects missing last name with diagnostics and keeps the router error envelope and CORS headers', async () => {
    const repository = {
      createOrUpdateEventReminderSubscription: vi.fn(),
    };
    const ctx = makeCtx({
      providers: { repository },
      env: {
        SITE_URL: 'https://letsilluminate.co',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
      } as any,
    });

    const res = await handleRequest(makeRequest({
      email: 'user@example.com',
      first_name: 'Ada',
      event_family: 'illuminate_evenings',
    }, {
      Origin: 'https://letsilluminate.co',
    }), ctx);

    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'last_name is required',
      request_id: 'req-1',
    });
    expect(repository.createOrUpdateEventReminderSubscription).not.toHaveBeenCalled();
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'event_reminder_subscription_request_started',
      context: expect.objectContaining({
        branch_taken: 'validate_public_reminder_subscription_payload',
        has_email: true,
        has_first_name: true,
        has_last_name: false,
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'event_reminder_subscription_validation_failed',
      context: expect.objectContaining({
        branch_taken: 'deny_missing_last_name',
        deny_reason: 'last_name_required',
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'event_reminder_subscription_request_failed',
      context: expect.objectContaining({
        status_code: 400,
        error_code: 'BAD_REQUEST',
        branch_taken: 'handled_api_error',
      }),
    }));
  });

  it('stores required names and emits completion diagnostics', async () => {
    const repository = {
      createOrUpdateEventReminderSubscription: vi.fn().mockResolvedValue({
        id: 'r1',
        email: 'user@example.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone: null,
        event_family: 'illuminate_evenings',
        created_at: '2026-03-18T07:00:00.000Z',
      }),
    };
    const ctx = makeCtx({ providers: { repository } });

    const res = await handleRequest(makeRequest({
      email: 'USER@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      event_family: 'illuminate_evenings',
    }), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: 'r1',
      email: 'user@example.com',
      event_family: 'illuminate_evenings',
    });
    expect(repository.createOrUpdateEventReminderSubscription).toHaveBeenCalledWith(expect.objectContaining({
      email: 'USER@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      event_family: 'illuminate_evenings',
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'event_reminder_subscription_validation_completed',
      context: expect.objectContaining({
        branch_taken: 'allow_valid_public_reminder_subscription_payload',
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'event_reminder_subscription_request_completed',
      context: expect.objectContaining({
        branch_taken: 'return_created_reminder_subscription',
        reminder_subscription_id: 'r1',
      }),
    }));
  });
});
