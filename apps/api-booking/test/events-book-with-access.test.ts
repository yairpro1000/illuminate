import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/booking-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/booking-service.js')>();
  return {
    ...actual,
    createEventBookingWithAccess: vi.fn(),
  };
});

import { handleRequest } from '../src/router.js';
import { hashToken } from '../src/services/token-service.js';
import { createEventBookingWithAccess } from '../src/services/booking-service.js';
import { makeCtx } from './admin-helpers.js';

const mockedCreateEventBookingWithAccess = vi.mocked(createEventBookingWithAccess);

const event = {
  id: 'evt-1',
  slug: 'ev-04-new-earth',
  title: 'New Earth Conversations',
  starts_at: '2026-06-19T17:00:00+00:00',
  ends_at: '2026-06-19T19:00:00+00:00',
  timezone: 'Europe/Zurich',
  location_name: 'Lugano',
  address_line: 'Lugano, Switzerland',
  maps_url: 'https://maps.google.com',
  is_paid: false,
  price_per_person_cents: 0,
  currency: 'CHF',
  capacity: 24,
  status: 'PUBLISHED',
  created_at: '2026-03-01T00:00:00.000Z',
  updated_at: '2026-03-01T00:00:00.000Z',
};

function makeRequest(body: Record<string, unknown>, extraHeaders?: Record<string, string>): Request {
  return new Request('https://api.local/api/events/ev-04-new-earth/book-with-access', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
  });
}

describe('events book-with-access handler diagnostics', () => {
  beforeEach(() => {
    mockedCreateEventBookingWithAccess.mockReset();
  });

  it('returns 400 with explicit token-gate diagnostics when access token is invalid', async () => {
    const repository = {
      getEventBySlug: vi.fn().mockResolvedValue(event),
      getEventLateAccessLinkByTokenHash: vi.fn().mockResolvedValue(null),
    };
    const ctx = makeCtx({ providers: { repository } });

    const res = await handleRequest(makeRequest({
      access_token: 'bad-token',
      first_name: 'Yair',
      email: 'yair@example.com',
      phone: '+41000000111',
      turnstile_token: 'ok',
    }), ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'Invalid or expired access token',
      request_id: 'req-1',
    });
    expect(mockedCreateEventBookingWithAccess).not.toHaveBeenCalled();
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'event_booking_with_access_token_gate_decision',
      context: expect.objectContaining({
        branch_taken: 'deny_invalid_or_expired_access_link',
        deny_reason: 'late_access_link_not_found',
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'event_booking_with_access_failed',
      context: expect.objectContaining({
        status_code: 400,
        error_code: 'BAD_REQUEST',
      }),
    }));
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_route_execution_failed',
      context: expect.objectContaining({
        status_code: 400,
        branch_taken: 'handled_api_error',
      }),
    }));
  });

  it('captures unexpected failures and preserves the INTERNAL_ERROR response envelope', async () => {
    const token = 'valid-token';
    const tokenHash = await hashToken(token);
    const repository = {
      getEventBySlug: vi.fn().mockResolvedValue(event),
      getEventLateAccessLinkByTokenHash: vi.fn().mockImplementation(async (_eventId: string, hash: string) => {
        if (hash !== tokenHash) return null;
        return {
          id: 'link-1',
          event_id: event.id,
          token_hash: tokenHash,
          expires_at: '2026-07-01T00:00:00.000Z',
          created_by_client_id: null,
          created_at: '2026-03-01T00:00:00.000Z',
          revoked_at: null,
        };
      }),
    };
    mockedCreateEventBookingWithAccess.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx({ providers: { repository } });

    const res = await handleRequest(makeRequest({
      access_token: token,
      first_name: 'Yair',
      email: 'yair@example.com',
      phone: '+41000000111',
      turnstile_token: 'ok',
    }), ctx);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
      request_id: 'req-1',
    });
    expect(ctx.logger.captureException).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_route_execution_failed',
      message: 'Booking route failed in shared inbound wrapper',
      context: expect.objectContaining({
        path: '/api/events/ev-04-new-earth/book-with-access',
        status_code: 500,
        branch_taken: 'unexpected_exception',
      }),
    }));
  });

  it('keeps CORS headers on router-level 500 responses for this endpoint', async () => {
    const token = 'valid-token';
    const tokenHash = await hashToken(token);
    const repository = {
      getEventBySlug: vi.fn().mockResolvedValue(event),
      getEventLateAccessLinkByTokenHash: vi.fn().mockResolvedValue({
        id: 'link-1',
        event_id: event.id,
        token_hash: tokenHash,
        expires_at: '2026-07-01T00:00:00.000Z',
        created_by_client_id: null,
        created_at: '2026-03-01T00:00:00.000Z',
        revoked_at: null,
      }),
    };
    mockedCreateEventBookingWithAccess.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx({
      providers: { repository },
      env: {
        SITE_URL: 'https://letsilluminate.co',
        API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
      } as any,
    });

    const req = makeRequest(
      {
        access_token: token,
        first_name: 'Yair',
        email: 'yair@example.com',
        phone: '+41000000111',
        turnstile_token: 'ok',
      },
      { Origin: 'https://letsilluminate.co' },
    );

    const res = await handleRequest(req, ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    await expect(res.json()).resolves.toEqual({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
      request_id: 'req-1',
    });
  });
});
