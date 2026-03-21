import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/router.js';
import { makeCtx } from './admin-helpers.js';

describe('test booking artifacts helper', () => {
  it('rejects missing email with explicit diagnostics', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/__test/booking-artifacts', { method: 'GET' });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'email is required',
      request_id: 'req-1',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'test_booking_artifacts_request_rejected',
      context: expect.objectContaining({
        branch_taken: 'deny_missing_email',
        deny_reason: 'email_missing',
      }),
    }));
  });

  it('rejects non-example.test emails', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/__test/booking-artifacts?email=user@example.com', { method: 'GET' });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'email must use @example.test',
      request_id: 'req-1',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'test_booking_artifacts_request_rejected',
      context: expect.objectContaining({
        branch_taken: 'deny_non_test_email_domain',
        deny_reason: 'email_must_use_example_test_domain',
      }),
    }));
  });

  it('returns latest booking links and payment artifacts for example.test bookings', async () => {
    const repository = {
      getClientByEmail: vi.fn().mockResolvedValue({
        id: 'client-1',
        email: 'p4-case@example.test',
      }),
      getOrganizerBookings: vi.fn().mockResolvedValue([
        {
          booking_id: 'booking-older',
          client_id: 'client-1',
          client_email: 'p4-case@example.test',
          current_status: 'PENDING',
          event_id: null,
          session_type_id: 'intro',
          starts_at: '2026-04-10T09:00:00.000Z',
          ends_at: '2026-04-10T10:00:00.000Z',
          timezone: 'Europe/Zurich',
          updated_at: '2026-03-10T10:00:00.000Z',
        },
        {
          booking_id: 'booking-newer',
          client_id: 'client-1',
          client_email: 'p4-case@example.test',
          current_status: 'PENDING',
          event_id: null,
          session_type_id: 'session',
          starts_at: '2026-04-11T09:00:00.000Z',
          ends_at: '2026-04-11T10:00:00.000Z',
          timezone: 'Europe/Zurich',
          updated_at: '2026-03-11T10:00:00.000Z',
        },
      ]),
      getBookingById: vi.fn().mockResolvedValue({
        id: 'booking-newer',
        current_status: 'PENDING',
        event_id: null,
        session_type_id: 'session',
        starts_at: '2026-04-11T09:00:00.000Z',
        ends_at: '2026-04-11T10:00:00.000Z',
        timezone: 'Europe/Zurich',
      }),
      listBookingEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt-1',
          booking_id: 'booking-newer',
          event_type: 'BOOKING_FORM_SUBMITTED',
          created_at: '2026-03-11T10:00:00.000Z',
          payload: { confirm_token: 'confirm-raw-token' },
        },
      ]),
      getPaymentByBookingId: vi.fn().mockResolvedValue({
        id: 'pay-1',
        status: 'PENDING',
        stripe_checkout_session_id: 'cs_test_123',
        checkout_url: 'https://letsilluminate.co/dev-pay?session_id=cs_test_123',
      }),
    };
    const ctx = makeCtx({
      env: { SITE_URL: 'https://letsilluminate.co' } as any,
      providers: { repository } as any,
    });
    const req = new Request('https://api.local/api/__test/booking-artifacts?email=p4-case@example.test', { method: 'GET' });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      client: {
        id: 'client-1',
        email: 'p4-case@example.test',
      },
      booking: {
        id: 'booking-newer',
        source: 'session',
        status: 'PENDING',
        event_id: null,
        session_type_id: 'session',
        starts_at: '2026-04-11T09:00:00.000Z',
        ends_at: '2026-04-11T10:00:00.000Z',
        timezone: 'Europe/Zurich',
      },
      links: {
        confirm_url: 'https://letsilluminate.co/confirm.html?token=confirm-raw-token',
        manage_url: 'https://letsilluminate.co/manage.html?token=m1.booking-newer',
      },
      payment: {
        id: 'pay-1',
        status: 'PENDING',
        session_id: 'cs_test_123',
        checkout_url: 'https://letsilluminate.co/dev-pay?session_id=cs_test_123',
      },
    });
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'test_booking_artifacts_request_completed',
      context: expect.objectContaining({
        booking_id: 'booking-newer',
        has_confirm_token: true,
        has_payment: true,
        branch_taken: 'return_test_booking_artifacts',
      }),
    }));
  });
});
