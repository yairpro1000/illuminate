import { describe, expect, it, vi } from 'vitest';

import { resolvePublicSiteUrl } from '../src/lib/public-site-url.js';
import { handleRequest } from '../src/router.js';
import { makeCtx, makeEnv, makeLogger } from './admin-helpers.js';

describe('public site URL resolution', () => {
  it('resolves yairb.ch from Origin and logs the branch', () => {
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
    expect(logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_site_url_resolution_completed',
      context: expect.objectContaining({
        resolved_site_url: 'https://yairb.ch',
        matched_header: 'origin',
        branch_taken: 'use_origin_header_site_url',
        deny_reason: null,
      }),
    }));
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
    expect(logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_site_url_resolution_completed',
      context: expect.objectContaining({
        resolved_site_url: 'https://letsilluminate.co',
        branch_taken: 'fallback_env_site_url',
        deny_reason: 'request_site_host_not_supported',
      }),
    }));
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
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'public_site_url_resolution_completed',
      context: expect.objectContaining({
        resolved_site_url: 'https://yairb.ch',
        branch_taken: 'use_origin_header_site_url',
      }),
    }));
  });
});
