import { describe, it, expect, vi } from 'vitest';
import { handleAdminCreateReminderSubscription } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin reminder subscriptions', () => {
  it('requires email', async () => {
    const ctx = makeCtx({ providers: { repository: {} } });
    await expect(handleAdminCreateReminderSubscription(adminRequest('POST', 'https://api.local/api/admin/reminder-subscriptions', {}), ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'email is required',
    });
  });

  it('creates or updates subscription with defaults', async () => {
    const repo = {
      createOrUpdateEventReminderSubscription: vi.fn().mockResolvedValue({ id: 'r1', email: 'user@example.com', event_family: 'illuminate_evenings' }),
    };
    const ctx = makeCtx({ providers: { repository: repo } });
    const res = await handleAdminCreateReminderSubscription(adminRequest('POST', 'https://api.local/api/admin/reminder-subscriptions', { email: 'USER@example.com' }), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('r1');
    expect(body.email).toBe('user@example.com');
    expect(body.event_family).toBe('illuminate_evenings');
  });

});
