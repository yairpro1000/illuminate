import { describe, expect, it, vi } from 'vitest';

import { resolvePublicSiteUrl } from '../src/lib/public-site-url.js';
import { handleAdminCreateBookingManageLink } from '../src/handlers/admin.js';
import { handleRequest } from '../src/router.js';
import { makeCtx, makeEnv, makeLogger } from './admin-helpers.js';

describe('public site URL resolution', () => {
  it('resolves yairb.ch from Origin without routine success logs', () => {
    const logger = makeLogger();
    const siteUrl = resolvePublicSiteUrl(
      new Request('https://api.local/api/bookings/pay-later', {
        headers: {
          Origin: 'https://yairb.ch',
        },
      }),
      makeEnv({ SITE_URL: 'https://letsilluminate.co' }),
      logger,
    );

    expect(siteUrl).toBe('https://yairb.ch');
    expect(logger.logInfo).not.toHaveBeenCalled();
    expect(logger.logWarn).not.toHaveBeenCalled();
  });

  it('falls back to SITE_URL for unsupported origins and logs the deny reason', () => {
    const logger = makeLogger();
    const siteUrl = resolvePublicSiteUrl(
      new Request('https://api.local/api/bookings/pay-later', {
        headers: {
          Origin: 'https://evil.example',
        },
      }),
      makeEnv({ SITE_URL: 'https://letsilluminate.co' }),
      logger,
    );

    expect(siteUrl).toBe('https://letsilluminate.co');
    expect(logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_site_url_resolution_fallback',
      context: expect.objectContaining({
        resolved_site_url: 'https://letsilluminate.co',
        branch_taken: 'fallback_env_site_url',
        deny_reason: 'request_site_host_not_supported',
      }),
    }));
  });

  it('maps admin-site origins to the temporary public Pages host', () => {
    const logger = makeLogger();
    const siteUrl = resolvePublicSiteUrl(
      new Request('https://api.local/api/admin/bookings/123/manage-link', {
        headers: {
          Origin: 'https://admin.letsilluminate.co',
        },
      }),
      makeEnv({ SITE_URL: 'https://letsilluminate.co' }),
      logger,
    );

    expect(siteUrl).toBe('https://illuminate-tw9.pages.dev');
    expect(logger.logInfo).not.toHaveBeenCalled();
    expect(logger.logWarn).not.toHaveBeenCalled();
  });

  it('maps illuminateadmin.pages.dev origins to the temporary public Pages host', () => {
    const logger = makeLogger();
    const siteUrl = resolvePublicSiteUrl(
      new Request('https://api.local/api/admin/bookings/123/manage-link', {
        headers: {
          Origin: 'https://illuminateadmin.pages.dev',
        },
      }),
      makeEnv({ SITE_URL: 'https://letsilluminate.co' }),
      logger,
    );

    expect(siteUrl).toBe('https://illuminate-tw9.pages.dev');
    expect(logger.logInfo).not.toHaveBeenCalled();
    expect(logger.logWarn).not.toHaveBeenCalled();
  });

  it('returns yairb.ch public links for pay-later bookings created from yairb.ch', async () => {
    const ctx = makeCtx({
      siteUrl: '',
      env: {
        SITE_URL: 'https://letsilluminate.co',
        EMAIL_MODE: 'mock',
      } as any,
      providers: {
        antibot: {
          verify: vi.fn().mockResolvedValue(undefined),
        },
        calendar: {
          getBusyTimes: vi.fn().mockResolvedValue([]),
          createEvent: vi.fn(),
          updateEvent: vi.fn(),
          deleteEvent: vi.fn(),
        },
        payments: {
          createCheckoutSession: vi.fn(),
          createInvoice: vi.fn(),
        },
        email: {
          sendBookingConfirmRequest: vi.fn().mockResolvedValue({ messageId: 'msg-confirm' }),
        },
      } as any,
    });

    const response = await handleRequest(
      new Request('https://api.local/api/bookings/pay-later', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://yairb.ch',
        },
        body: JSON.stringify({
          slot_start: '2026-03-29T10:00:00.000Z',
          slot_end: '2026-03-29T11:00:00.000Z',
          timezone: 'Europe/Zurich',
          type: 'session',
          client_name: 'Origin Scoped',
          client_email: 'origin-scoped@example.com',
          client_phone: '+41000000081',
          turnstile_token: 'ok',
        }),
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      continue_payment_url: expect.stringContaining('https://yairb.ch/continue-payment.html?token=m1.'),
      manage_url: expect.stringContaining('https://yairb.ch/manage.html?token=m1.'),
    }));
    expect(ctx.logger.logWarn).not.toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_site_url_resolution_fallback',
    }));
  });

  it('returns temporary public Pages links for admin-share manage links', async () => {
    const bookingId = '00000000-0000-4000-8000-000000000111';
    const ctx = makeCtx({
      siteUrl: 'https://illuminate-tw9.pages.dev',
      env: {
        SITE_URL: 'https://letsilluminate.co',
      } as any,
      providers: {
        repository: {
          getBookingById: vi.fn().mockResolvedValue({
            id: bookingId,
            client_id: 'client-1',
            event_id: null,
            session_type_id: 'session-type-1',
            starts_at: '2026-03-22T10:00:00.000Z',
            ends_at: '2026-03-22T11:00:00.000Z',
            timezone: 'Europe/Zurich',
            google_event_id: null,
            address_line: 'Somewhere 1, Zurich',
            maps_url: 'https://maps.example',
            current_status: 'CONFIRMED',
            notes: null,
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-01T00:00:00.000Z',
          }),
        },
      } as any,
    });
    ctx.env.JOB_SECRET = 'test-secret';

    const response = await handleAdminCreateBookingManageLink(
      new Request(`https://api.local/api/admin/bookings/${bookingId}/manage-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'admin@example.com',
        },
        body: '{}',
      }),
      ctx,
      { bookingId },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      booking_id: bookingId,
      url: expect.stringContaining('https://illuminate-tw9.pages.dev/manage.html?token=m1.'),
    }));
  });
});
