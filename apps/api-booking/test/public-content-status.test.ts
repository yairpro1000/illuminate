import { describe, expect, it, vi } from 'vitest';

import { handleGetEvents } from '../src/handlers/events.js';
import { handleGetSessionTypes } from '../src/handlers/session-types.js';
import { makeCtx } from './admin-helpers.js';

describe('public content status normalization', () => {
  it('returns public events when repository rows use uppercase DB statuses and logs the result path', async () => {
    const publishedEvent = {
      id: 'evt-published',
      slug: 'ev-published',
      title: 'Published Event',
      description: 'desc',
      starts_at: '2099-06-19T17:00:00.000Z',
      ends_at: '2099-06-19T19:00:00.000Z',
      timezone: 'Europe/Zurich',
      location_name: 'Lugano',
      address_line: 'Lugano',
      maps_url: 'https://maps.example/published',
      is_paid: false,
      price_per_person: 0,
      currency: 'CHF',
      capacity: 24,
      status: 'PUBLISHED',
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    };
    const soldOutEvent = {
      ...publishedEvent,
      id: 'evt-sold-out',
      slug: 'ev-sold-out',
      title: 'Sold Out Event',
      maps_url: 'https://maps.example/sold-out',
      status: 'SOLD_OUT',
      capacity: 10,
    };
    const eventsById = new Map([
      [publishedEvent.id, publishedEvent],
      [soldOutEvent.id, soldOutEvent],
    ]);
    const repository = {
      getPublishedEvents: vi.fn().mockResolvedValue([publishedEvent, soldOutEvent]),
      getEventById: vi.fn().mockImplementation(async (eventId: string) => eventsById.get(eventId) ?? null),
      countEventActiveBookings: vi.fn().mockImplementation(async (eventId: string) => eventId === soldOutEvent.id ? 3 : 2),
    };
    const ctx = makeCtx({ providers: { repository } });

    const res = await handleGetEvents(new Request('https://api.local/api/events'), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      events: [
        expect.objectContaining({
          id: 'evt-published',
          status: 'published',
          render: expect.objectContaining({
            public_registration_open: true,
            sold_out: false,
          }),
        }),
        expect.objectContaining({
          id: 'evt-sold-out',
          status: 'sold_out',
          render: expect.objectContaining({
            public_registration_open: false,
            sold_out: true,
            late_access_active: false,
          }),
        }),
      ],
    });
    expect(repository.countEventActiveBookings).toHaveBeenCalledTimes(2);
    expect('getActiveEventLateAccessLinkForEvent' in repository).toBe(false);
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_events_request_completed',
      context: expect.objectContaining({
        returned_event_count: 2,
        event_status_counts: { published: 1, sold_out: 1 },
        branch_taken: 'return_public_events',
      }),
    }));
  });

  it('returns public session types when repository rows use uppercase DB statuses and logs the result path', async () => {
    const repository = {
      getPublicSessionTypes: vi.fn().mockResolvedValue([
        {
          id: 'st-1',
          title: 'Intro',
          slug: 'intro',
          short_description: 'Start here',
          description: 'Description',
          duration_minutes: 60,
          price: 0,
          currency: 'CHF',
          status: 'ACTIVE',
          sort_order: 1,
          image_key: null,
          drive_file_id: null,
          image_alt: null,
          created_at: '2026-03-01T00:00:00.000Z',
          updated_at: '2026-03-01T00:00:00.000Z',
        },
      ]),
    };
    const ctx = makeCtx({ providers: { repository } });

    const res = await handleGetSessionTypes(new Request('https://api.local/api/session-types'), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      session_types: [
        expect.objectContaining({
          id: 'st-1',
          status: 'active',
        }),
      ],
    });
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_session_types_request_completed',
      context: expect.objectContaining({
        returned_session_type_count: 1,
        session_type_status_counts: { active: 1 },
        branch_taken: 'return_public_session_types',
      }),
    }));
  });
});
