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
    const getBookingByIdSpy = vi.spyOn(ctx.providers.repository, 'getBookingById');
    getBookingByIdSpy.mockClear();

    const res = await handleRequest(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.matched_count).toBe(2);
    expect(body.active_matched_count).toBe(1);
    expect(body.processed_count).toBe(1);
    expect(body.remaining_active_count).toBe(0);
    expect(body.batch_limit).toBe(10);
    expect(body.canceled_count).toBe(1);
    expect(body.skipped_count).toBe(1);
    expect(body.failed_count).toBe(0);
    expect(body.canceled).toEqual([
      { booking_id: active.bookingId, status: 'CANCELED' },
    ]);
    expect(body.skipped).toEqual([
      { booking_id: terminal.bookingId, status: 'CANCELED', reason: 'already_terminal' },
    ]);
    expect(getBookingByIdSpy).toHaveBeenCalledTimes(1);
    expect(getBookingByIdSpy).toHaveBeenCalledWith(active.bookingId);

    const activeBooking = await ctx.providers.repository.getBookingById(active.bookingId);
    const otherBooking = await ctx.providers.repository.getBookingById(other.bookingId);
    expect(activeBooking?.current_status).toBe('CANCELED');
    expect(otherBooking?.current_status).toBe('PENDING');

    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'test_bookings_cleanup_completed',
      context: expect.objectContaining({
        email_prefix: 'p4-wipe',
        matched_count: 2,
        active_matched_count: 1,
        processed_count: 1,
        remaining_active_count: 0,
        batch_limit: 10,
        canceled_count: 1,
        skipped_count: 1,
        failed_count: 0,
        branch_taken: 'cleanup_completed_successfully',
      }),
    }));
  });

  it('processes cleanup in bounded batches and leaves remaining active bookings for later calls', async () => {
    const ctx = makeCtx();
    const first = await createIntroBooking('p4-batch-a@example.test', '2026-03-30T10:00:00.000Z', '2026-03-30T10:30:00.000Z', ctx);
    const second = await createIntroBooking('p4-batch-b@example.test', '2026-03-30T11:00:00.000Z', '2026-03-30T11:30:00.000Z', ctx);
    const third = await createIntroBooking('p4-batch-c@example.test', '2026-03-30T12:00:00.000Z', '2026-03-30T12:30:00.000Z', ctx);

    const req = new Request('https://api.local/api/__test/bookings/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email_prefix: 'p4-batch', limit: 2 }),
    });

    const res = await handleRequest(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.matched_count).toBe(3);
    expect(body.active_matched_count).toBe(3);
    expect(body.processed_count).toBe(2);
    expect(body.remaining_active_count).toBe(1);
    expect(body.batch_limit).toBe(2);
    expect(body.canceled_count).toBe(2);
    expect(body.failed_count).toBe(0);

    const firstBooking = await ctx.providers.repository.getBookingById(first.bookingId);
    const secondBooking = await ctx.providers.repository.getBookingById(second.bookingId);
    const thirdBooking = await ctx.providers.repository.getBookingById(third.bookingId);
    expect(firstBooking?.current_status).toBe('CANCELED');
    expect(secondBooking?.current_status).toBe('CANCELED');
    expect(thirdBooking?.current_status).toBe('PENDING');
  });

  it('mutates latest test booking times and submission age for deterministic edge-case setup', async () => {
    const ctx = makeCtx();
    const created = await createIntroBooking('p4-mutate@example.test', '2026-03-31T10:00:00.000Z', '2026-03-31T10:30:00.000Z', ctx);
    const beforeArtifactsReq = new Request('https://api.local/api/__test/booking-artifacts?email=p4-mutate@example.test', { method: 'GET' });
    const beforeRes = await handleRequest(beforeArtifactsReq, ctx);
    const beforeBody = await beforeRes.json();
    const beforeBookingId = beforeBody.booking.id as string;
    const beforeEvents = await ctx.providers.repository.listBookingEvents(beforeBookingId);
    const submitted = beforeEvents.find((event: any) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    expect(submitted).toBeTruthy();

    const mutateReq = new Request('https://api.local/api/__test/bookings/mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'p4-mutate@example.test',
        starts_at: '2026-03-31T08:00:00.000Z',
        ends_at: '2026-03-31T08:30:00.000Z',
        latest_submission_created_at: '2026-03-30T08:00:00.000Z',
      }),
    });

    const mutateRes = await handleRequest(mutateReq, ctx);
    const mutateBody = await mutateRes.json();

    expect(mutateRes.status).toBe(200);
    expect(mutateBody.booking_id).toBe(created.bookingId);
    expect(mutateBody.starts_at).toBe('2026-03-31T08:00:00.000Z');
    expect(mutateBody.ends_at).toBe('2026-03-31T08:30:00.000Z');
    expect(mutateBody.updated_submission_event_id).toBe(submitted.id);

    const updatedBooking = await ctx.providers.repository.getBookingById(created.bookingId);
    const updatedEvents = await ctx.providers.repository.listBookingEvents(created.bookingId);
    const updatedSubmitted = updatedEvents.find((event: any) => event.id === submitted.id);
    expect(updatedBooking?.starts_at).toBe('2026-03-31T08:00:00.000Z');
    expect(updatedBooking?.ends_at).toBe('2026-03-31T08:30:00.000Z');
    expect(updatedSubmitted?.created_at).toBe('2026-03-30T08:00:00.000Z');
  });

  it('expires the latest test booking through the real booking transition with explicit diagnostics', async () => {
    const ctx = makeCtx();
    const created = await createIntroBooking('p4-expire@example.test', '2026-04-01T10:00:00.000Z', '2026-04-01T10:30:00.000Z', ctx);

    const expireReq = new Request('https://api.local/api/__test/bookings/expire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'p4-expire@example.test' }),
    });

    const expireRes = await handleRequest(expireReq, ctx);
    const expireBody = await expireRes.json();

    expect(expireRes.status).toBe(200);
    expect(expireBody).toEqual({
      email: 'p4-expire@example.test',
      booking_id: created.bookingId,
      status: 'EXPIRED',
    });

    const updatedBooking = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(updatedBooking?.current_status).toBe('EXPIRED');

    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'test_booking_expire_decision',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        booking_status: 'PENDING',
        branch_taken: 'allow_test_booking_expiry',
        deny_reason: null,
      }),
    }));

    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'test_booking_expire_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        booking_status: 'EXPIRED',
        branch_taken: 'return_test_booking_expiry_result',
      }),
    }));
  });
});
