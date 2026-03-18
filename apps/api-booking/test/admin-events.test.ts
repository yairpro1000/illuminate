import { describe, it, expect, vi } from 'vitest';
import { handleAdminGetEvents, handleAdminUpdateEvent } from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin events', () => {
  it('returns published events for admin', async () => {
    const events = [
      { id: 'e1', slug: 's1', title: 'T1', starts_at: '2026-03-10T18:00:00Z', ends_at: '2026-03-10T20:00:00Z', status: 'published' },
    ];
    const ctx = makeCtx({ providers: { repository: { getAllEvents: vi.fn().mockResolvedValue(events) } } });
    const req = adminRequest('GET', 'https://api.local/api/admin/events');
    const res = await handleAdminGetEvents(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([
      { id: 'e1', slug: 's1', title: 'T1', starts_at: events[0].starts_at, ends_at: events[0].ends_at, status: 'published' },
    ]);
  });

  it('rejects unauthorized access', async () => {
    const ctx = makeCtx({ providers: { repository: { getAllEvents: vi.fn() } } });
    const req = new Request('https://api.local/api/admin/events', { method: 'GET' });
    await expect(handleAdminGetEvents(req, ctx)).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Admin authentication required',
    });
  });

  it('logs auth start and auth failure details for admin events', async () => {
    const ctx = makeCtx({ providers: { repository: { getAllEvents: vi.fn() } } });
    const req = new Request('https://api.local/api/admin/events', { method: 'GET' });
    await expect(handleAdminGetEvents(req, ctx)).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Admin authentication required',
    });
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_events_request',
      context: expect.objectContaining({
        path: '/api/admin/events',
        admin_auth_disabled: false,
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_events_request_failed',
      context: expect.objectContaining({
        path: '/api/admin/events',
        admin_auth_disabled: false,
        status_code: 401,
      }),
    }));
  });

  it('updates event marketing content and logs the decision path', async () => {
    const existing = {
      id: 'e1',
      slug: 'body',
      title: 'Body',
      description: 'Legacy',
      marketing_content: null,
    };
    const updated = {
      ...existing,
      marketing_content: {
        subtitle: 'A guided evening',
        intro: 'Slow down and listen inward.',
        what_to_expect: ['guided meditation', 'grounded sharing'],
        takeaways: ['more clarity'],
      },
    };
    const repo = {
      getEventById: vi.fn().mockResolvedValue(existing),
      updateEvent: vi.fn().mockResolvedValue(updated),
    };
    const ctx = makeCtx({ providers: { repository: repo } });
    const req = adminRequest('PATCH', 'https://api.local/api/admin/events/e1', {
      marketing_content: {
        subtitle: '  A guided evening  ',
        intro: 'Slow down and listen inward.',
        what_to_expect: ['guided meditation', '  ', 'grounded sharing'],
        takeaways: ['more clarity'],
      },
    });

    const res = await handleAdminUpdateEvent(req, ctx, { eventId: 'e1' });
    expect(res.status).toBe(200);
    expect(repo.updateEvent).toHaveBeenCalledWith('e1', expect.objectContaining({
      marketing_content: {
        subtitle: 'A guided evening',
        intro: 'Slow down and listen inward.',
        what_to_expect: ['guided meditation', 'grounded sharing'],
        takeaways: ['more clarity'],
      },
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_event_update_patch_decision',
      context: expect.objectContaining({
        event_id: 'e1',
        has_marketing_content: true,
        marketing_has_subtitle: true,
        marketing_what_to_expect_count: 2,
        marketing_takeaways_count: 1,
        branch_taken: 'apply_event_updates',
      }),
    }));
  });

  it('rejects invalid marketing content payloads and logs the failure reason', async () => {
    const repo = {
      getEventById: vi.fn().mockResolvedValue({ id: 'e1', marketing_content: null }),
      updateEvent: vi.fn(),
    };
    const ctx = makeCtx({ providers: { repository: repo } });
    const req = adminRequest('PATCH', 'https://api.local/api/admin/events/e1', {
      marketing_content: 'invalid',
    });

    await expect(handleAdminUpdateEvent(req, ctx, { eventId: 'e1' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'marketing_content must be an object',
    });
    expect(repo.updateEvent).not.toHaveBeenCalled();
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_event_update_failed',
      context: expect.objectContaining({
        event_id: 'e1',
        status_code: 400,
        branch_taken: 'propagate_error_to_shared_wrapper',
        deny_reason: 'marketing_content must be an object',
      }),
    }));
  });
});
