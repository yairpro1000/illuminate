import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/router.js';
import { createPayLaterBooking } from '../src/services/booking-service.js';
import { MockRepository } from '../src/providers/repository/mock.js';
import { MockEmailProvider } from '../src/providers/email/mock.js';
import { MockCalendarProvider } from '../src/providers/calendar/mock.js';
import { MockPaymentsProvider } from '../src/providers/payments/mock.js';
import { MockAntiBotProvider } from '../src/providers/antibot/mock.js';
import { mockState } from '../src/providers/mock-state.js';
import { createOperationContext } from '../src/lib/execution.js';

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
    env: {
      REPOSITORY_MODE: 'mock',
      EMAIL_MODE: 'mock',
      CALENDAR_MODE: 'mock',
      PAYMENTS_MODE: 'mock',
      ANTIBOT_MODE: 'mock',
      SITE_URL: 'https://example.com',
      SESSION_ADDRESS: 'Somewhere 1, Zurich',
      SESSION_MAPS_URL: 'https://maps.example',
      API_ALLOWED_ORIGINS: '*',
      TIMEZONE: 'Europe/Zurich',
    } as any,
    logger: {
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
      captureException: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      logMilestone: vi.fn(),
      logRequest: vi.fn(),
    } as any,
    requestId: 'req-1',
    correlationId: 'corr-1',
    operation: createOperationContext({ appArea: 'website', requestId: 'req-1', correlationId: 'corr-1' }),
  } as any;
}

async function createIntroBooking(email: string, slotStart: string, slotEnd: string, ctx: ReturnType<typeof makeCtx>) {
  return createPayLaterBooking({
    slotStart,
    slotEnd,
    timezone: 'Europe/Zurich',
    sessionType: 'intro',
    clientName: 'P4 Cleanup',
    clientEmail: email,
    clientPhone: '+41000000014',
    reminderEmailOptIn: true,
    reminderWhatsappOptIn: false,
    turnstileToken: 'ok',
    remoteIp: null,
  }, ctx);
}

beforeEach(() => {
  resetMockState();
});

describe('test bookings helpers', () => {
  it('rejects missing email_prefix on list helper with explicit diagnostics', async () => {
    const ctx = makeCtx();
    const req = new Request('https://api.local/api/__test/bookings', { method: 'GET' });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'BAD_REQUEST',
      message: 'email_prefix is required',
      request_id: 'req-1',
    });
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'test_bookings_list_request_rejected',
      context: expect.objectContaining({
        branch_taken: 'deny_missing_email_prefix',
        deny_reason: 'email_prefix_missing',
      }),
    }));
  });

  it('lists only example.test bookings matching the email prefix', async () => {
    const ctx = makeCtx();
    await createIntroBooking('p4-clean-a@example.test', '2026-03-28T10:00:00.000Z', '2026-03-28T10:30:00.000Z', ctx);
    await createIntroBooking('p4-clean-b@example.test', '2026-03-28T11:00:00.000Z', '2026-03-28T11:30:00.000Z', ctx);
    await createIntroBooking('other-clean@example.test', '2026-03-28T12:00:00.000Z', '2026-03-28T12:30:00.000Z', ctx);

    const req = new Request('https://api.local/api/__test/bookings?email_prefix=p4-clean', { method: 'GET' });
    const res = await handleRequest(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.bookings.map((row: any) => row.client_email)).toEqual([
      'p4-clean-a@example.test',
      'p4-clean-b@example.test',
    ]);
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'test_bookings_list_request_completed',
      context: expect.objectContaining({
        email_prefix: 'p4-clean',
        matched_count: 2,
        branch_taken: 'return_test_bookings_list',
      }),
    }));
  });

  it('cancels matching active test bookings and skips terminal ones through the normal cancellation path', async () => {
    const ctx = makeCtx();
    const active = await createIntroBooking('p4-wipe-active@example.test', '2026-03-29T10:00:00.000Z', '2026-03-29T10:30:00.000Z', ctx);
    const terminal = await createIntroBooking('p4-wipe-terminal@example.test', '2026-03-29T11:00:00.000Z', '2026-03-29T11:30:00.000Z', ctx);
    const other = await createIntroBooking('other-prefix@example.test', '2026-03-29T12:00:00.000Z', '2026-03-29T12:30:00.000Z', ctx);

    await ctx.providers.repository.updateBooking(terminal.bookingId, { current_status: 'CANCELED' });

    const req = new Request('https://api.local/api/__test/bookings/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email_prefix: 'p4-wipe' }),
    });

    const res = await handleRequest(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.matched_count).toBe(2);
    expect(body.canceled_count).toBe(1);
    expect(body.skipped_count).toBe(1);
    expect(body.failed_count).toBe(0);
    expect(body.canceled).toEqual([
      { booking_id: active.bookingId, status: 'CANCELED' },
    ]);
    expect(body.skipped).toEqual([
      { booking_id: terminal.bookingId, status: 'CANCELED', reason: 'already_terminal' },
    ]);

    const activeBooking = await ctx.providers.repository.getBookingById(active.bookingId);
    const otherBooking = await ctx.providers.repository.getBookingById(other.bookingId);
    expect(activeBooking?.current_status).toBe('CANCELED');
    expect(otherBooking?.current_status).toBe('PENDING');

    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'test_bookings_cleanup_completed',
      context: expect.objectContaining({
        email_prefix: 'p4-wipe',
        matched_count: 2,
        canceled_count: 1,
        skipped_count: 1,
        failed_count: 0,
        branch_taken: 'cleanup_completed_successfully',
      }),
    }));
  });
});
