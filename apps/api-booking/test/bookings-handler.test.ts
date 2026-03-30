import { beforeEach, describe, expect, it } from 'vitest';

import { handleRequest } from '../src/router.js';
import { MockAntiBotProvider } from '../src/providers/antibot/mock.js';
import { MockCalendarProvider } from '../src/providers/calendar/mock.js';
import { MockEmailProvider } from '../src/providers/email/mock.js';
import { mockState } from '../src/providers/mock-state.js';
import { MockPaymentsProvider } from '../src/providers/payments/mock.js';
import { MockRepository } from '../src/providers/repository/mock.js';
import { createOperationContext } from '../src/lib/execution.js';
import { makeEnv, makeLogger } from './admin-helpers.js';

const seededEvents = [...mockState.events.values()].map((event) => ({ ...event }));

function resetMockState() {
  mockState.clients.clear();
  mockState.bookings.clear();
  mockState.events.clear();
  for (const event of seededEvents) {
    mockState.events.set(event.id, { ...event });
  }
  mockState.eventLateAccessLinks.clear();
  mockState.eventReminderSubscriptions.clear();
  mockState.contactMessages.clear();
  mockState.payments.clear();
  mockState.sentEmails.length = 0;
  mockState.bookingEvents.length = 0;
  mockState.sideEffects.length = 0;
  mockState.sideEffectAttempts.length = 0;
}

function makeCtx() {
  const repository = new MockRepository();
  return {
    providers: {
      repository,
      email: new MockEmailProvider(),
      calendar: new MockCalendarProvider(),
      payments: new MockPaymentsProvider('https://example.com'),
      antibot: new MockAntiBotProvider(),
    } as any,
    env: makeEnv({
      SITE_URL: 'https://letsilluminate.co',
      API_ALLOWED_ORIGINS: 'https://letsilluminate.co',
    }),
    logger: makeLogger(),
    requestId: 'req-bookings-handler',
    correlationId: 'corr-bookings-handler',
    operation: createOperationContext({
      appArea: 'website',
      requestId: 'req-bookings-handler',
      correlationId: 'corr-bookings-handler',
    }),
    executionCtx: undefined,
  } as any;
}

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://api.local${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://letsilluminate.co',
      'CF-Connecting-IP': '203.0.113.10',
    },
    body: JSON.stringify(body),
  });
}

function introBookingPayload(slotStart: string, slotEnd: string) {
  return {
    slot_start: slotStart,
    slot_end: slotEnd,
    timezone: 'Europe/Zurich',
    type: 'intro',
    client_name: 'Intro HTTP',
    client_email: 'intro-http@example.com',
    client_phone: '+41000000103',
    reminder_email_opt_in: true,
    reminder_whatsapp_opt_in: false,
    turnstile_token: 'ok',
  };
}

beforeEach(() => {
  resetMockState();
});

describe('bookings handler intro limits', () => {
  it('returns a friendly 409 envelope with CORS headers when a second intro booking is attempted', async () => {
    const ctx = makeCtx();

    const firstResponse = await handleRequest(
      jsonRequest('/api/bookings/pay-later', introBookingPayload('2026-03-24T09:00:00+01:00', '2026-03-24T09:45:00+01:00')),
      ctx,
    );
    expect(firstResponse.status).toBe(200);

    const secondResponse = await handleRequest(
      jsonRequest('/api/bookings/pay-later', introBookingPayload('2026-04-02T11:00:00+02:00', '2026-04-02T11:45:00+02:00')),
      ctx,
    );

    expect(secondResponse.status).toBe(409);
    expect(secondResponse.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    await expect(secondResponse.json()).resolves.toEqual({
      error: 'CLIENT_INTRO_SESSION_LIMIT_REACHED',
      message: 'You can only book one intro session. If you need help with an existing intro booking, please contact me.',
      request_id: 'req-bookings-handler',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_route_execution_failed',
      context: expect.objectContaining({
        path: '/api/bookings/pay-later',
        status_code: 409,
        error_code: 'CLIENT_INTRO_SESSION_LIMIT_REACHED',
        deny_reason: 'CLIENT_INTRO_SESSION_LIMIT_REACHED',
      }),
    }));
  });

  it('fails closed for invalid admin token on booking creation with the standard auth envelope and diagnostics', async () => {
    const ctx = makeCtx();

    const response = await handleRequest(
      jsonRequest('/api/bookings/pay-later', {
        slot_start: '2026-03-24T09:00:00+01:00',
        slot_end: '2026-03-24T09:45:00+01:00',
        timezone: 'Europe/Zurich',
        type: 'session',
        offer_slug: 'cycle-session',
        client_name: 'Admin Fail',
        client_email: 'admin-fail@example.com',
        client_phone: '+41000000104',
        reminder_email_opt_in: true,
        reminder_whatsapp_opt_in: false,
        turnstile_token: 'ok',
        admin_token: 'invalid-token',
      }),
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://letsilluminate.co');
    await expect(response.json()).resolves.toEqual({
      error: 'UNAUTHORIZED',
      message: 'Invalid or expired admin token',
      request_id: 'req-bookings-handler',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_submission_admin_token_decision_completed',
      context: expect.objectContaining({
        has_admin_token: true,
        admin_token_valid: false,
        branch_taken: 'deny_invalid_admin_token_for_creation',
        deny_reason: 'admin_token_invalid_or_expired',
      }),
    }));
  });
});
