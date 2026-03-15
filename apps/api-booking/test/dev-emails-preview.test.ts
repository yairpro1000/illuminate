import { beforeEach, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/router.js';
import { MockEmailProvider } from '../src/providers/email/mock.js';
import { mockState } from '../src/providers/mock-state.js';
import { makeCtx } from './admin-helpers.js';

function resetCapturedEmails() {
  mockState.sentEmails.length = 0;
}

describe('dev captured email preview', () => {
  beforeEach(() => {
    resetCapturedEmails();
  });

  it('captures the exact provider payload for mocked booking confirmation emails', async () => {
    const provider = new MockEmailProvider();

    await provider.sendBookingConfirmRequest({
      id: 'bk-1',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.test',
      session_type_title: 'Cycle Session',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any, 'https://letsilluminate.co/confirm.html?token=test-confirm', 15);

    expect(mockState.sentEmails).toHaveLength(1);
    expect(mockState.sentEmails[0]).toMatchObject({
      from: 'Illuminate Contact <bookings@letsilluminate.co>',
      to: 'maya@example.test',
      kind: 'booking_confirm_request',
      replyTo: 'hello@yairb.ch',
    });
    expect(mockState.sentEmails[0]?.text).toContain('Confirm: https://letsilluminate.co/confirm.html?token=test-confirm');
    expect(mockState.sentEmails[0]?.html).toContain('Confirm booking');
    expect(mockState.sentEmails[0]?.html).toContain('https://letsilluminate.co/confirm.html?token=test-confirm');
    expect(mockState.sentEmails[0]?.html).toContain('ILLUMINATE_hero.png');
  });

  it('lists captured emails, returns captured payload detail, and serves raw preview html', async () => {
    const provider = new MockEmailProvider();
    await provider.sendBookingConfirmRequest({
      id: 'bk-2',
      client_first_name: 'Maya',
      client_last_name: 'Doe',
      client_email: 'maya@example.test',
      session_type_title: 'Cycle Session',
      starts_at: '2026-03-19T10:00:00.000Z',
      ends_at: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      address_line: 'Via Example 1, Lugano',
    } as any, 'https://letsilluminate.co/confirm.html?token=preview-token', 15);

    const captured = mockState.sentEmails[0];
    const ctx = makeCtx({
      env: { SITE_URL: 'https://letsilluminate.co', EMAIL_MODE: 'mock' } as any,
    });

    const listRes = await handleRequest(new Request('https://api.local/api/__dev/emails', { method: 'GET' }), ctx);
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toEqual({
      emails: [
        expect.objectContaining({
          id: captured?.id,
          to: 'maya@example.test',
          kind: 'booking_confirm_request',
          has_html: true,
          preview_html_url: `https://api.local/api/__dev/emails/${captured?.id}/html`,
        }),
      ],
    });
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'dev_emails_list_completed',
      context: expect.objectContaining({
        branch_taken: 'return_captured_emails',
      }),
    }));

    const detailRes = await handleRequest(new Request(`https://api.local/api/__dev/emails/${captured?.id}`, { method: 'GET' }), ctx);
    expect(detailRes.status).toBe(200);
    await expect(detailRes.json()).resolves.toEqual({
      email: expect.objectContaining({
        id: captured?.id,
        to: 'maya@example.test',
        text: expect.stringContaining('preview-token'),
        html: expect.stringContaining('Confirm booking'),
      }),
    });

    const htmlRes = await handleRequest(new Request(`https://api.local/api/__dev/emails/${captured?.id}/html`, { method: 'GET' }), ctx);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toContain('text/html');
    await expect(htmlRes.text()).resolves.toContain('preview-token');
  });

  it('returns a diagnosable 404 envelope when the captured email id does not exist', async () => {
    const ctx = makeCtx({
      env: { SITE_URL: 'https://letsilluminate.co', EMAIL_MODE: 'mock' } as any,
    });

    const res = await handleRequest(new Request('https://api.local/api/__dev/emails/missing-id', { method: 'GET' }), ctx);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'NOT_FOUND',
      message: 'Captured email not found',
      request_id: 'req-1',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'dev_email_preview_request_rejected',
      context: expect.objectContaining({
        branch_taken: 'deny_missing_captured_email',
        deny_reason: 'captured_email_not_found',
      }),
    }));
  });
});
