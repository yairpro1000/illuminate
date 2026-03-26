import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/router.js';
import { makeCtx } from './admin-helpers.js';

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(`https://api.local${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('events book handler diagnostics', () => {
  it('rejects missing payment_mode on paid events with explicit diagnostics', async () => {
    const paidEvent = {
      id: 'evt-1',
      slug: 'paid-evening',
      title: 'Paid Evening',
      starts_at: '2026-06-19T17:00:00+00:00',
      ends_at: '2026-06-19T19:00:00+00:00',
      timezone: 'Europe/Zurich',
      location_name: 'Lugano',
      address_line: 'Lugano, Switzerland',
      maps_url: 'https://maps.google.com',
      is_paid: true,
      price_per_person: 35,
      currency: 'CHF',
      capacity: 24,
      status: 'PUBLISHED',
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    };
    const ctx = makeCtx({
      providers: {
        repository: {
          getEventBySlug: vi.fn().mockResolvedValue(paidEvent),
          countActiveBookingsForEvent: vi.fn().mockResolvedValue(0),
        },
      } as any,
    });

    const res = await handleRequest(jsonRequest('/api/events/paid-evening/book', {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.test',
      turnstile_token: 'ok',
    }), ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'payment_mode must be pay_now or pay_at_event for paid events',
      request_id: 'req-1',
    });
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'event_booking_payment_mode_decision',
      context: expect.objectContaining({
        event_is_paid: true,
        requested_payment_mode: null,
        branch_taken: 'deny_invalid_paid_event_payment_mode',
        deny_reason: 'payment_mode_invalid_for_paid_event',
      }),
    }));
  });

  it('rejects missing phone on paid events', async () => {
    const paidEvent = {
      id: 'evt-1',
      slug: 'paid-evening',
      title: 'Paid Evening',
      starts_at: '2026-06-19T17:00:00+00:00',
      ends_at: '2026-06-19T19:00:00+00:00',
      timezone: 'Europe/Zurich',
      location_name: 'Lugano',
      address_line: 'Lugano, Switzerland',
      maps_url: 'https://maps.google.com',
      is_paid: true,
      price_per_person: 35,
      currency: 'CHF',
      capacity: 24,
      status: 'PUBLISHED',
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    };
    const ctx = makeCtx({
      providers: {
        repository: {
          getEventBySlug: vi.fn().mockResolvedValue(paidEvent),
          countActiveBookingsForEvent: vi.fn().mockResolvedValue(0),
        },
      } as any,
    });

    const res = await handleRequest(jsonRequest('/api/events/paid-evening/book', {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.test',
      payment_mode: 'pay_at_event',
      turnstile_token: 'ok',
    }), ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'phone is required for event bookings',
      request_id: 'req-1',
    });
  });
});
