import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelBooking,
  confirmBookingEmail,
  confirmBookingPayment,
  createEventBooking,
  createPayLaterBooking,
  createPayNowBooking,
  rescheduleBooking,
} from '../src/services/booking-service.js';
import { runSideEffectsOutbox } from '../src/handlers/jobs.js';
import { MockRepository, resetMockSessionTypesForTests } from '../src/providers/repository/mock.js';
import { MockEmailProvider } from '../src/providers/email/mock.js';
import { MockCalendarProvider } from '../src/providers/calendar/mock.js';
import { RetryableCalendarWriteError } from '../src/providers/calendar/interface.js';
import { MockPaymentsProvider } from '../src/providers/payments/mock.js';
import { MockAntiBotProvider } from '../src/providers/antibot/mock.js';
import { mockState } from '../src/providers/mock-state.js';

const seededEvents = [...mockState.events.values()].map((event) => ({ ...event }));

function resetMockState() {
  resetMockSessionTypesForTests();
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
  mockState.sessionTypeAvailabilityWindows.clear();
  mockState.sessionTypeWeekOverrides.clear();
  mockState.sentEmails.length = 0;
  mockState.bookingEvents.length = 0;
  mockState.sideEffects.length = 0;
  mockState.sideEffectAttempts.length = 0;
}

function makeCtx(overrides?: { email?: any; calendar?: any }) {
  const repository = new MockRepository();
  const providers = {
    repository,
    email: overrides?.email ?? new MockEmailProvider(),
    calendar: overrides?.calendar ?? new MockCalendarProvider(),
    payments: new MockPaymentsProvider('https://example.com'),
    antibot: new MockAntiBotProvider(),
  } as any;

  return {
    providers,
    env: {
      SITE_URL: 'https://example.com',
      SESSION_ADDRESS: 'Somewhere 1, Zurich',
      SESSION_MAPS_URL: 'https://maps.example',
      TIMEZONE: 'Europe/Zurich',
    } as any,
    logger: {
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      captureException: vi.fn(),
    } as any,
    requestId: 'req-1',
  };
}

beforeEach(() => {
  resetMockState();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('booking domain model', () => {
  it('creates pay-now, pay-later, and free bookings with phase-2 vocabulary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00.000Z'));
    const ctx = makeCtx();

    const payNow = await createPayNowBooking({
      slotStart: '2026-03-17T10:00:00.000Z',
      slotEnd: '2026-03-17T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Jane Doe',
      clientEmail: 'jane@example.com',
      clientPhone: '+41000000001',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const payLater = await createPayLaterBooking({
      slotStart: '2026-03-18T12:00:00.000Z',
      slotEnd: '2026-03-18T13:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'John Doe',
      clientEmail: 'john@example.com',
      clientPhone: '+41000000002',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const freeEvent = [...mockState.events.values()].find((event) => !event.is_paid)!;
    const free = await createEventBooking({
      event: freeEvent,
      firstName: 'Alice',
      lastName: 'Example',
      email: 'alice@example.com',
      phone: '+41000000003',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    expect(payLater.status).toBe('PENDING');
    expect(free.status).toBe('PENDING');
    expect(payNow.checkoutUrl).toContain('session_id=');

    const payNowBooking = await ctx.providers.repository.getBookingById(payNow.bookingId);
    const payLaterBooking = await ctx.providers.repository.getBookingById(payLater.bookingId);
    const freeBooking = await ctx.providers.repository.getBookingById(free.bookingId);
    expect(payNowBooking?.booking_type).toBe('PAY_NOW');
    expect(payLaterBooking?.booking_type).toBe('PAY_LATER');
    expect(freeBooking?.booking_type).toBe('FREE');

    const payNowEffects = mockState.sideEffects
      .filter((effect) => effect.booking_id === payNow.bookingId)
      .map((effect) => effect.effect_intent);
    expect(payNowEffects).toEqual(expect.arrayContaining(['CREATE_STRIPE_CHECKOUT', 'VERIFY_STRIPE_PAYMENT']));

    const payLaterEffects = mockState.sideEffects
      .filter((effect) => effect.booking_id === payLater.bookingId)
      .map((effect) => effect.effect_intent);
    expect(payLaterEffects).toEqual(expect.arrayContaining(['SEND_BOOKING_CONFIRMATION_REQUEST', 'VERIFY_EMAIL_CONFIRMATION']));
    expect(payLaterEffects).not.toEqual(expect.arrayContaining(['SEND_PAYMENT_REMINDER', 'VERIFY_STRIPE_PAYMENT']));

    const freeEventConfirmEmail = mockState.sentEmails.find(
      (email) => email.kind === 'event_confirm_request' && email.to === 'alice@example.com',
    );
    expect(freeEventConfirmEmail).toBeTruthy();
    expect(freeEventConfirmEmail?.body).toContain('Your spot is kindly held for the next');
    expect(freeEventConfirmEmail?.body).toContain('before expiring.');
  });

  it('applies coupon discounts to booking snapshots and downstream checkout amounts', async () => {
    const ctx = makeCtx();

    const payNow = await createPayNowBooking({
      slotStart: '2026-03-17T10:00:00.000Z',
      slotEnd: '2026-03-17T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      offerSlug: 'first-clarity-session',
      clientName: 'Jane Doe',
      clientEmail: 'jane@example.com',
      clientPhone: '+41000000001',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
      couponCode: 'ISRAEL',
    }, ctx);

    const payNowBooking = await ctx.providers.repository.getBookingById(payNow.bookingId);
    const payNowPayment = await ctx.providers.repository.getPaymentByBookingId(payNow.bookingId);
    expect(payNowBooking?.price).toBe(112.5);
    expect(payNowBooking?.currency).toBe('CHF');
    expect(payNowBooking?.coupon_code).toBe('ISRAEL');
    expect(payNowPayment?.amount).toBe(112.5);

    const payLater = await createPayLaterBooking({
      slotStart: '2026-03-18T12:00:00.000Z',
      slotEnd: '2026-03-18T13:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      offerSlug: 'cycle-session',
      clientName: 'John Doe',
      clientEmail: 'john@example.com',
      clientPhone: '+41000000002',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
      couponCode: 'ISRAEL',
    }, ctx);

    const payLaterBooking = await ctx.providers.repository.getBookingById(payLater.bookingId);
    const payLaterPayment = await ctx.providers.repository.getPaymentByBookingId(payLater.bookingId);
    expect(payLaterBooking?.price).toBe(90);
    expect(payLaterBooking?.coupon_code).toBe('ISRAEL');
    expect(payLaterPayment).toBeNull();
  });

  it('rejects invalid coupon codes during booking creation', async () => {
    const ctx = makeCtx();

    await expect(createPayNowBooking({
      slotStart: '2026-03-17T10:00:00.000Z',
      slotEnd: '2026-03-17T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      offerSlug: 'first-clarity-session',
      clientName: 'Jane Doe',
      clientEmail: 'jane@example.com',
      clientPhone: '+41000000001',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
      couponCode: 'NOTREAL',
    }, ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_COUPON',
      message: 'Invalid coupon code',
    });
  });

  it('confirms free 1:1 bookings after email confirmation', async () => {
    const ctx = makeCtx();

    const created = await createPayLaterBooking({
      slotStart: '2026-03-19T15:00:00.000Z',
      slotEnd: '2026-03-19T15:30:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Intro Doe',
      clientEmail: 'intro@example.com',
      clientPhone: '+41000000014',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    const confirmed = await confirmBookingEmail(token, ctx);
    expect(confirmed.current_status).toBe('CONFIRMED');
    expect(confirmed.google_event_id).toBeTruthy();
    expect(confirmed.meeting_provider).toBe('google_meet');
    expect(confirmed.meeting_link).toContain('https://meet.google.com/');

    const verificationEffect = submission
      ? mockState.sideEffects.find(
        (effect) => effect.booking_event_id === submission.id && effect.effect_intent === 'VERIFY_EMAIL_CONFIRMATION',
      )
      : null;
    const verificationAttempt = verificationEffect
      ? mockState.sideEffectAttempts.find((attempt) => attempt.booking_side_effect_id === verificationEffect.id)
      : null;
    expect(verificationEffect?.status).toBe('SUCCESS');
    expect(verificationAttempt?.status).toBe('SUCCESS');

    const confirmationEffects = submission
      ? mockState.sideEffects.filter(
        (effect) => effect.booking_event_id === submission.id
          && (effect.effect_intent === 'RESERVE_CALENDAR_SLOT' || effect.effect_intent === 'SEND_BOOKING_CONFIRMATION'),
      )
      : [];
    expect(confirmationEffects.map((effect) => effect.effect_intent)).toEqual([
      'RESERVE_CALENDAR_SLOT',
      'SEND_BOOKING_CONFIRMATION',
    ]);
    const confirmationAttempts = confirmationEffects.map((effect) =>
      mockState.sideEffectAttempts.find((attempt) => attempt.booking_side_effect_id === effect.id),
    );
    expect(confirmationAttempts.every((attempt) => attempt?.status === 'SUCCESS')).toBe(true);

    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'intro@example.com',
    );
    expect(confirmationEmail).toBeTruthy();
    expect(confirmationEmail?.body).toContain('Join Google Meet:');
    expect(confirmationEmail?.body).toContain(String(confirmed.meeting_link));
    expect(confirmationEmail?.body).toContain('Add to calendar: https://calendar.google.com/calendar/render?');
  });

  it('keeps free 1:1 confirmation successful when calendar sync is pending retry', async () => {
    const calendar = new MockCalendarProvider();
    calendar.createEvent = vi.fn().mockRejectedValue(new Error('calendar create failed')) as any;
    const ctx = makeCtx({ calendar });

    const created = await createPayLaterBooking({
      slotStart: '2026-03-19T16:00:00.000Z',
      slotEnd: '2026-03-19T16:30:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Retry Intro',
      clientEmail: 'retry-intro@example.com',
      clientPhone: '+41000000015',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    const confirmed = await confirmBookingEmail(token, ctx);
    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'retry-intro@example.com',
    );

    expect(confirmed.current_status).toBe('CONFIRMED');
    expect(confirmed.google_event_id).toBeNull();
    expect(confirmed.meeting_link).toBeNull();
    expect(confirmationEmail).toBeTruthy();
    expect(confirmationEmail?.body).not.toContain('Join Google Meet:');
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_confirmation_email_dispatch_degraded',
      context: expect.objectContaining({
        booking_id: confirmed.id,
        branch_taken: 'send_confirmation_without_calendar_invite',
        deny_reason: 'calendar_sync_pending_retry',
      }),
    }));
    const retryEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'RESERVE_CALENDAR_SLOT',
    );
    const retryAttempt = retryEffect
      ? mockState.sideEffectAttempts.find((attempt) => attempt.booking_side_effect_id === retryEffect.id)
      : null;
    expect(retryEffect).toBeTruthy();
    expect(retryEffect?.status).toBe('FAILED');
    expect(retryEffect?.expires_at).toBeNull();
    expect(retryAttempt?.attempt_num).toBe(1);
    expect(retryAttempt?.status).toBe('FAILED');
  });

  it('allows a second 1:1 session in the same local week and logs the allow branch', async () => {
    const ctx = makeCtx();

    await createPayLaterBooking({
      slotStart: '2026-03-24T09:00:00+01:00',
      slotEnd: '2026-03-24T09:30:00+01:00',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Weekly Limit',
      clientEmail: 'weekly-limit@example.com',
      clientPhone: '+41000000100',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const second = await createPayLaterBooking({
      slotStart: '2026-03-26T11:00:00+01:00',
      slotEnd: '2026-03-26T12:00:00+01:00',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Weekly Limit',
      clientEmail: 'weekly-limit@example.com',
      clientPhone: '+41000000100',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    expect(second.status).toBe('PENDING');
    expect(ctx.logger.logInfo.mock.calls).toContainEqual([
      expect.objectContaining({
        eventType: 'client_weekly_session_limit_check_started',
        context: expect.objectContaining({
          branch_taken: 'count_client_sessions_for_local_week',
          weekly_limit: 2,
          week_start_date: '2026-03-23',
          week_end_exclusive_date: '2026-03-30',
        }),
      }),
    ]);
    expect(ctx.logger.logInfo.mock.calls).toContainEqual([
      expect.objectContaining({
        eventType: 'client_weekly_session_limit_check_completed',
        context: expect.objectContaining({
          branch_taken: 'allow_client_weekly_session_limit',
          existing_active_session_count: 1,
          attempted_session_count: 2,
          deny_reason: null,
        }),
      }),
    ]);
  });

  it('rejects a third 1:1 session in the same local week and logs the deny branch', async () => {
    const ctx = makeCtx();

    await createPayLaterBooking({
      slotStart: '2026-03-24T09:00:00+01:00',
      slotEnd: '2026-03-24T09:30:00+01:00',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Weekly Limit',
      clientEmail: 'weekly-limit@example.com',
      clientPhone: '+41000000100',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    await createPayLaterBooking({
      slotStart: '2026-03-26T11:00:00+01:00',
      slotEnd: '2026-03-26T12:00:00+01:00',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Weekly Limit',
      clientEmail: 'weekly-limit@example.com',
      clientPhone: '+41000000100',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    await expect(createPayLaterBooking({
      slotStart: '2026-03-27T13:00:00+01:00',
      slotEnd: '2026-03-27T14:00:00+01:00',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Weekly Limit',
      clientEmail: 'weekly-limit@example.com',
      clientPhone: '+41000000100',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLIENT_WEEKLY_SESSION_LIMIT_REACHED',
      message: 'A client can have at most 2 active 1:1 sessions in the same week.',
    });

    expect(ctx.logger.logWarn.mock.calls).toContainEqual([
      expect.objectContaining({
        eventType: 'client_weekly_session_limit_check_completed',
        context: expect.objectContaining({
          branch_taken: 'deny_client_weekly_session_limit_reached',
          existing_active_session_count: 2,
          attempted_session_count: 3,
          deny_reason: 'max_2_sessions_per_local_week_reached',
        }),
      }),
    ]);
  });

  it('rejects an intro booking when the session-type weekly cap is reached and logs the deny branch', async () => {
    const ctx = makeCtx();
    await ctx.providers.repository.updateSessionType('mock-st-1', {
      availability_mode: 'dedicated',
      availability_timezone: 'Europe/Zurich',
      weekly_booking_limit: 3,
      slot_step_minutes: 30,
    });
    await ctx.providers.repository.replaceSessionTypeAvailabilityWindows('mock-st-1', [
      {
        session_type_id: 'mock-st-1',
        weekday_iso: 4,
        start_local_time: '11:00:00',
        end_local_time: '13:00:00',
        sort_order: 0,
        active: true,
      },
      {
        session_type_id: 'mock-st-1',
        weekday_iso: 4,
        start_local_time: '16:00:00',
        end_local_time: '19:00:00',
        sort_order: 1,
        active: true,
      },
      {
        session_type_id: 'mock-st-1',
        weekday_iso: 5,
        start_local_time: '11:00:00',
        end_local_time: '16:00:00',
        sort_order: 2,
        active: true,
      },
    ]);

    for (const [email, start, end] of [
      ['intro-cap-1@example.com', '2026-03-26T11:00:00+01:00', '2026-03-26T11:45:00+01:00'],
      ['intro-cap-2@example.com', '2026-03-26T16:00:00+01:00', '2026-03-26T16:45:00+01:00'],
      ['intro-cap-3@example.com', '2026-03-27T11:00:00+01:00', '2026-03-27T11:45:00+01:00'],
    ]) {
      await createPayLaterBooking({
        slotStart: start,
        slotEnd: end,
        timezone: 'Europe/Zurich',
        sessionType: 'intro',
        clientName: 'Intro Cap',
        clientEmail: email,
        clientPhone: '+41000000200',
        reminderEmailOptIn: true,
        reminderWhatsappOptIn: false,
        turnstileToken: 'ok',
        remoteIp: null,
      }, ctx);
    }

    await expect(createPayLaterBooking({
      slotStart: '2026-03-27T12:00:00+01:00',
      slotEnd: '2026-03-27T12:45:00+01:00',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Intro Cap',
      clientEmail: 'intro-cap-4@example.com',
      clientPhone: '+41000000201',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SESSION_TYPE_WEEK_CAP_REACHED',
      message: 'This offer has reached its weekly booking limit for the selected week.',
    });

    expect(ctx.logger.logWarn.mock.calls).toContainEqual([
      expect.objectContaining({
        eventType: 'session_type_week_capacity_check_completed',
        context: expect.objectContaining({
          session_type_id: 'mock-st-1',
          branch_taken: 'deny_session_type_week_limit_reached',
          effective_weekly_limit: 3,
          active_booking_count: 3,
          deny_reason: 'session_type_week_limit_reached',
        }),
      }),
    ]);
  });

  it('allows a replacement intro session after a prior intro was marked NO_SHOW', async () => {
    const ctx = makeCtx();

    const first = await createPayLaterBooking({
      slotStart: '2026-03-24T09:00:00+01:00',
      slotEnd: '2026-03-24T09:45:00+01:00',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Intro Retry',
      clientEmail: 'intro-retry@example.com',
      clientPhone: '+41000000101',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    await ctx.providers.repository.updateBooking(first.bookingId, { current_status: 'NO_SHOW' });

    const second = await createPayLaterBooking({
      slotStart: '2026-04-02T11:00:00+02:00',
      slotEnd: '2026-04-02T11:45:00+02:00',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Intro Retry',
      clientEmail: 'intro-retry@example.com',
      clientPhone: '+41000000101',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    expect(second.status).toBe('PENDING');
    expect(ctx.logger.logInfo.mock.calls).toContainEqual([
      expect.objectContaining({
        eventType: 'client_intro_session_limit_check_completed',
        context: expect.objectContaining({
          branch_taken: 'allow_client_intro_session_limit',
          existing_intro_booking_count: 0,
          attempted_intro_booking_count: 1,
          deny_reason: null,
        }),
      }),
    ]);
  });

  it('rejects another intro session once the client already has a completed intro booking', async () => {
    const ctx = makeCtx();

    const first = await createPayLaterBooking({
      slotStart: '2026-03-24T09:00:00+01:00',
      slotEnd: '2026-03-24T09:45:00+01:00',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Intro Once',
      clientEmail: 'intro-once@example.com',
      clientPhone: '+41000000102',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    await ctx.providers.repository.updateBooking(first.bookingId, { current_status: 'COMPLETED' });

    await expect(createPayLaterBooking({
      slotStart: '2026-04-02T11:00:00+02:00',
      slotEnd: '2026-04-02T11:45:00+02:00',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Intro Once',
      clientEmail: 'intro-once@example.com',
      clientPhone: '+41000000102',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLIENT_INTRO_SESSION_LIMIT_REACHED',
      message: 'You can only book one intro session. If you need help with an existing intro booking, please contact me.',
    });

    expect(mockState.bookings.size).toBe(1);
    expect(ctx.logger.logWarn.mock.calls).toContainEqual([
      expect.objectContaining({
        eventType: 'client_intro_session_limit_check_completed',
        context: expect.objectContaining({
          branch_taken: 'deny_client_intro_session_limit_reached',
          existing_intro_booking_count: 1,
          attempted_intro_booking_count: 2,
          deny_reason: 'client_already_has_non_rebookable_intro_booking',
        }),
      }),
    ]);
  });

  it('schedules retryable calendar confirmation failures with backoff and logs calendar_retry', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const calendar = new MockCalendarProvider();
    calendar.createEvent = vi.fn().mockRejectedValue(
      new RetryableCalendarWriteError(
        'Google createEvent failed (403): quotaExceeded',
        { statusCode: 403, reason: 'quotaExceeded' },
      ),
    ) as any;
    const ctx = makeCtx({ calendar });

    const created = await createPayLaterBooking({
      slotStart: '2026-03-19T18:00:00.000Z',
      slotEnd: '2026-03-19T18:30:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Quota Retry',
      clientEmail: 'quota-retry@example.com',
      clientPhone: '+41000000017',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    const beforeConfirmMs = Date.now();
    const confirmed = await confirmBookingEmail(token, ctx);

    expect(confirmed.current_status).toBe('CONFIRMED');
    expect(confirmed.google_event_id).toBeNull();

    const retryEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'RESERVE_CALENDAR_SLOT',
    );
    expect(retryEffect).toBeTruthy();
    expect(retryEffect?.status).toBe('FAILED');
    expect(retryEffect?.max_attempts).toBe(5);
    expect(retryEffect?.expires_at).toBeTruthy();

    const retryAttempt = retryEffect
      ? mockState.sideEffectAttempts.find((attempt) => attempt.booking_side_effect_id === retryEffect.id)
      : null;
    expect(retryAttempt?.attempt_num).toBe(1);
    expect(retryAttempt?.status).toBe('FAILED');

    const scheduledDelayMs = new Date(String(retryEffect?.expires_at)).getTime() - beforeConfirmMs;
    expect(scheduledDelayMs).toBeGreaterThanOrEqual(4_000);
    expect(scheduledDelayMs).toBeLessThanOrEqual(6_500);
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'calendar_retry',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        attempt: 1,
        delay_ms: 5_000,
        reason: 'Google createEvent failed (403): quotaExceeded',
        request_id: 'req-1',
      }),
    }));
  });

  it('retries missing calendar sync when the same confirmed session link is opened again', async () => {
    const calendar = new MockCalendarProvider();
    calendar.createEvent = vi.fn()
      .mockRejectedValueOnce(new Error('calendar create failed'))
      .mockResolvedValueOnce({
        eventId: 'g-retry-confirm',
        htmlLink: 'https://calendar.google.com/calendar/event?eid=g-retry-confirm',
        meetingProvider: 'google_meet',
        meetingLink: 'https://meet.google.com/retry-confirm',
      }) as any;
    const ctx = makeCtx({ calendar });

    const created = await createPayLaterBooking({
      slotStart: '2026-03-20T16:00:00.000Z',
      slotEnd: '2026-03-20T16:30:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'Retry Confirm',
      clientEmail: 'retry-confirm@example.com',
      clientPhone: '+41000000016',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    const firstConfirm = await confirmBookingEmail(token, ctx);
    expect(firstConfirm.current_status).toBe('CONFIRMED');
    expect(firstConfirm.google_event_id).toBeNull();

    const secondConfirm = await confirmBookingEmail(token, ctx);
    expect(secondConfirm.current_status).toBe('CONFIRMED');
    expect(secondConfirm.google_event_id).toBe('g-retry-confirm');
    expect(secondConfirm.meeting_link).toBe('https://meet.google.com/retry-confirm');
    expect(calendar.createEvent).toHaveBeenCalledTimes(2);
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_email_confirmation_repeat_sync_decision',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'retry_confirmed_booking_calendar_sync',
        deny_reason: null,
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_email_confirmation_repeat_sync_outcome',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        calendar_synced: true,
        branch_taken: 'repeat_confirmation_calendar_sync_succeeded',
        deny_reason: null,
      }),
    }));
  });

  it('keeps pay-later bookings pending after submission and sends a confirmation request', async () => {
    const ctx = makeCtx();

    const created = await createPayLaterBooking({
      slotStart: '2026-03-19T10:00:00.000Z',
      slotEnd: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Maya Doe',
      clientEmail: 'maya@example.com',
      clientPhone: '+41000000004',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const pending = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(pending?.current_status).toBe('PENDING');
    expect(pending?.google_event_id).toBeNull();

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(payment).toBeNull();

    const confirmRequestEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirm_request' && email.to === 'maya@example.com',
    );
    expect(confirmRequestEmail).toBeTruthy();
    expect(confirmRequestEmail?.body).toContain('Please confirm your session booking.');

    const followupEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_payment_due' && email.to === 'maya@example.com',
    );
    expect(followupEmail).toBeFalsy();

    const confirmEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'SEND_BOOKING_CONFIRMATION_REQUEST',
    );
    const verifyEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'VERIFY_EMAIL_CONFIRMATION',
    );
    expect(confirmEffect).toBeTruthy();
    expect(verifyEffect?.expires_at).toBeTruthy();
  });

  it('confirms pay-later bookings, creates the payment row, and sends a confirmed-but-unpaid email', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    const ctx = makeCtx();

    const created = await createPayLaterBooking({
      slotStart: '2026-03-19T10:00:00.000Z',
      slotEnd: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Maya Doe',
      clientEmail: 'maya@example.com',
      clientPhone: '+41000000004',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    const confirmed = await confirmBookingEmail(token, ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'maya@example.com',
    );

    expect(confirmed.current_status).toBe('CONFIRMED');
    expect(confirmed.google_event_id).toBeTruthy();
    expect(payment?.status).toBe('PENDING');
    expect(payment?.invoice_url).toBeNull();
    expect(payment?.checkout_url).toBeNull();
    expect(confirmationEmail?.subject).toBe('Your session on Mar 19 is confirmed');
    expect(confirmationEmail?.body).toContain('payment is still pending for');
    expect(confirmationEmail?.body).toContain('Payment due:');
    expect(confirmationEmail?.body).not.toContain('Invoice:');
    expect(confirmationEmail?.body).toContain('Complete payment: https://example.com/continue-payment.html?token=m1.');
    expect(confirmationEmail?.body).toContain('For online sessions, a video conference link will be sent at the day of the session.');
    expect(confirmationEmail?.body).not.toContain('confirmed and paid');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'pay_later_confirmation_payment_bootstrap_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'confirmation_skipped_stripe_bootstrap_until_continue_payment',
        has_invoice_url: false,
        has_checkout_url: false,
      }),
    }));

    const reminderEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'SEND_PAYMENT_REMINDER',
    );
    const verifyEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'VERIFY_STRIPE_PAYMENT',
    );
    expect(reminderEffect?.expires_at).toBeTruthy();
    expect(verifyEffect?.expires_at).toBeTruthy();
  });

  it('keeps pay-later confirmation Stripe-free and omits the invoice line', async () => {
    const ctx = makeCtx();
    const created = await createPayLaterBooking({
      slotStart: '2026-03-22T10:00:00.000Z',
      slotEnd: '2026-03-22T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Fallback Doe',
      clientEmail: 'fallback@example.com',
      clientPhone: '+41000000024',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    const confirmed = await confirmBookingEmail(token, ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'fallback@example.com',
    );

    expect(confirmed.current_status).toBe('CONFIRMED');
    expect(payment?.status).toBe('PENDING');
    expect(payment?.invoice_url).toBeNull();
    expect(payment?.checkout_url).toBeNull();
    expect(confirmationEmail?.subject).toBe('Your session on Mar 22 is confirmed');
    expect(confirmationEmail?.body).toContain('Complete payment: https://example.com/continue-payment.html?token=m1.');
    expect(confirmationEmail?.body).not.toContain('Invoice:');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'pay_later_confirmation_payment_bootstrap_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'confirmation_skipped_stripe_bootstrap_until_continue_payment',
        deny_reason: null,
      }),
    }));
  });

  it('confirms pay-now bookings after payment settlement', async () => {
    const ctx = makeCtx();

    const created = await createPayNowBooking({
      slotStart: '2026-03-26T10:00:00.000Z',
      slotEnd: '2026-03-26T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Paid Doe',
      clientEmail: 'paid@example.com',
      clientPhone: '+41000000015',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await confirmBookingPayment({
      id: payment!.id,
      booking_id: payment!.booking_id,
      stripe_checkout_session_id: payment!.stripe_checkout_session_id,
      stripe_payment_intent_id: payment!.stripe_payment_intent_id,
      stripe_invoice_id: payment!.stripe_invoice_id,
      status: payment!.status,
    }, {
      paymentIntentId: 'pi_123',
      invoiceId: 'in_123',
      invoiceUrl: null,
    }, ctx);

    const updated = await ctx.providers.repository.getBookingById(created.bookingId);
    const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'paid@example.com',
    );
    expect(updated?.current_status).toBe('CONFIRMED');
    expect(updated?.google_event_id).toBeTruthy();
    expect(updated?.meeting_provider).toBe('google_meet');
    expect(updated?.meeting_link).toContain('https://meet.google.com/');
    expect(refreshedPayment?.status).toBe('SUCCEEDED');
    expect(refreshedPayment?.invoice_url).toBe('https://example.com/mock-invoice/in_123.pdf');
    expect(refreshedPayment?.stripe_receipt_url).toBe('https://example.com/mock-receipt/mock_ch_pi_123.html');
    expect(confirmationEmail?.body).toContain('Invoice: https://example.com/mock-invoice/in_123.pdf');
    expect(confirmationEmail?.body).toContain('Receipt: https://example.com/mock-receipt/mock_ch_pi_123.html');
    expect(confirmationEmail?.body).toContain('For online sessions, a video conference link will be sent at the day of the session.');
    expect(confirmationEmail?.html).toContain('View invoice');
    expect(confirmationEmail?.html).toContain('View receipt');
  });

  it('includes the invoice URL in paid event confirmation emails when settlement can resolve it', async () => {
    const ctx = makeCtx();
    const paidEvent = [...mockState.events.values()].find((event) => event.is_paid)!;

    const created = await createEventBooking({
      event: paidEvent,
      firstName: 'Paid',
      lastName: 'Event',
      email: 'paid-event@example.com',
      phone: '+41000000019',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await confirmBookingPayment({
      id: payment!.id,
      booking_id: payment!.booking_id,
      stripe_checkout_session_id: payment!.stripe_checkout_session_id,
      stripe_payment_intent_id: payment!.stripe_payment_intent_id,
      stripe_invoice_id: payment!.stripe_invoice_id,
      status: payment!.status,
    }, {
      paymentIntentId: 'pi_event_paid_123',
      invoiceId: 'in_event_paid_123',
      invoiceUrl: null,
    }, ctx);

    const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'event_confirmation' && email.to === 'paid-event@example.com',
    );

    expect(refreshedPayment?.status).toBe('SUCCEEDED');
    expect(refreshedPayment?.invoice_url).toBe('https://example.com/mock-invoice/in_event_paid_123.pdf');
    expect(refreshedPayment?.stripe_receipt_url).toBe('https://example.com/mock-receipt/mock_ch_pi_event_paid_123.html');
    expect(confirmationEmail?.body).toContain('Invoice: https://example.com/mock-invoice/in_event_paid_123.pdf');
    expect(confirmationEmail?.body).toContain('Receipt: https://example.com/mock-receipt/mock_ch_pi_event_paid_123.html');
    expect(confirmationEmail?.body).toContain('For online sessions, a video conference link will be sent at the day of the session.');
    expect(confirmationEmail?.html).toContain('View invoice');
    expect(confirmationEmail?.html).toContain('View receipt');
  });

  it('still sends the pay-now confirmation email when calendar reservation is retryable and queued', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const calendar = new MockCalendarProvider();
    calendar.createEvent = vi.fn().mockRejectedValue(
      new RetryableCalendarWriteError(
        'Google createEvent failed (403): quotaExceeded',
        { statusCode: 403, reason: 'quotaExceeded' },
      ),
    ) as any;
    const ctx = makeCtx({ calendar });

    const created = await createPayNowBooking({
      slotStart: '2026-03-26T12:00:00.000Z',
      slotEnd: '2026-03-26T13:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Paid Retry',
      clientEmail: 'paid-retry@example.com',
      clientPhone: '+41000000018',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await confirmBookingPayment({
      id: payment!.id,
      booking_id: payment!.booking_id,
      stripe_checkout_session_id: payment!.stripe_checkout_session_id,
      stripe_payment_intent_id: payment!.stripe_payment_intent_id,
      stripe_invoice_id: payment!.stripe_invoice_id,
      status: payment!.status,
    }, {
      paymentIntentId: 'pi_retry',
      invoiceId: 'in_retry',
      invoiceUrl: 'https://invoice.example/in_retry',
    }, ctx);

    const updated = await ctx.providers.repository.getBookingById(created.bookingId);
    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'paid-retry@example.com',
    );
    const retryEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'RESERVE_CALENDAR_SLOT',
    );
    const confirmationEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'SEND_BOOKING_CONFIRMATION',
    );

    expect(updated?.current_status).toBe('CONFIRMED');
    expect(updated?.google_event_id).toBeNull();
    expect(confirmationEmail?.subject).toBe('Your session on Mar 26 is confirmed and paid');
    expect(retryEffect?.status).toBe('FAILED');
    expect(retryEffect?.expires_at).toBeTruthy();
    expect(confirmationEffect?.status).toBe('SUCCESS');
  });

  it('generates and persists a mock invoice URL when mock payment settlement succeeds without one', async () => {
    const ctx = makeCtx();

    const created = await createPayNowBooking({
      slotStart: '2026-03-27T10:00:00.000Z',
      slotEnd: '2026-03-27T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Invoice Doe',
      clientEmail: 'invoice@example.com',
      clientPhone: '+41000000017',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await confirmBookingPayment({
      id: payment!.id,
      booking_id: payment!.booking_id,
      stripe_checkout_session_id: payment!.stripe_checkout_session_id,
      stripe_payment_intent_id: payment!.stripe_payment_intent_id,
      stripe_invoice_id: payment!.stripe_invoice_id,
      status: payment!.status,
    }, {
      paymentIntentId: 'pi_456',
      invoiceId: null,
      invoiceUrl: null,
    }, ctx);

    const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'invoice@example.com',
    );

    expect(refreshedPayment?.status).toBe('SUCCEEDED');
    expect(refreshedPayment?.invoice_url).toBe(
      'https://example.com/mock-invoice/mock_inv_pi_456.pdf',
    );
    expect(refreshedPayment?.stripe_receipt_url).toBe('https://example.com/mock-receipt/mock_ch_pi_456.html');
    expect(confirmationEmail?.body).toContain(
      'Invoice: https://example.com/mock-invoice/mock_inv_pi_456.pdf',
    );
    expect(confirmationEmail?.body).toContain('Receipt: https://example.com/mock-receipt/mock_ch_pi_456.html');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'payment_settlement_invoice_resolution_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'fetched_invoice_url_from_provider',
        resolved_invoice_url_present: true,
      }),
    }));
  });

  it('sends confirmation without a broken meet placeholder when calendar creation returns no meet link', async () => {
    const ctx = makeCtx({
      calendar: {
        getBusyTimes: vi.fn().mockResolvedValue([]),
        createEvent: vi.fn().mockResolvedValue({
          eventId: 'g-no-meet',
          meetingProvider: null,
          meetingLink: null,
        }),
        updateEvent: vi.fn().mockResolvedValue({
          eventId: 'g-no-meet',
          meetingProvider: null,
          meetingLink: null,
        }),
        deleteEvent: vi.fn().mockResolvedValue(undefined),
      },
    });

    const created = await createPayLaterBooking({
      slotStart: '2026-03-29T15:00:00.000Z',
      slotEnd: '2026-03-29T15:30:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'intro',
      clientName: 'No Meet Doe',
      clientEmail: 'nomeet@example.com',
      clientPhone: '+41000000016',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    const confirmed = await confirmBookingEmail(token, ctx);
    expect(confirmed.google_event_id).toBe('g-no-meet');
    expect(confirmed.meeting_provider ?? null).toBeNull();
    expect(confirmed.meeting_link ?? null).toBeNull();

    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'nomeet@example.com',
    );
    expect(confirmationEmail).toBeTruthy();
    expect(confirmationEmail?.body).not.toContain('Join Google Meet: undefined');
    expect(confirmationEmail?.body).not.toContain('Join Google Meet: null');
    expect(confirmationEmail?.body).not.toContain('Join Google Meet:');
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'calendar_meet_link_missing_after_create',
      context: expect.objectContaining({
        booking_id: confirmed.id,
        google_event_id: 'g-no-meet',
        branch_taken: 'calendar_event_created_without_meet_link',
      }),
    }));
  });

  it('expires pending bookings through verification side effects and keeps reschedule/cancel flows on new intents', async () => {
    const ctx = makeCtx();

    const created = await createPayLaterBooking({
      slotStart: '2026-03-23T10:00:00.000Z',
      slotEnd: '2026-03-23T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Nora Doe',
      clientEmail: 'nora@example.com',
      clientPhone: '+41000000007',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');
    await confirmBookingEmail(token, ctx);

    const verifyEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'VERIFY_STRIPE_PAYMENT',
    );
    expect(verifyEffect).toBeTruthy();
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(payment).toBeTruthy();
    await ctx.providers.repository.updatePayment(payment!.id, { status: 'FAILED' });
    verifyEffect!.expires_at = '2000-01-01T00:00:00.000Z';

    await runSideEffectsOutbox({ ...ctx, triggerSource: 'manual' } as any);

    const expired = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(expired?.current_status).toBe('EXPIRED');
    const expiryEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_expired' && email.to === 'nora@example.com',
    );
    expect(expiryEmail).toBeTruthy();
    expect(expiryEmail?.subject).toBe('Your booking on Mar 23 expired');
    expect(expiryEmail?.text).toContain('expired because it was not completed in time');
    expect(expiryEmail?.text).toContain('The slot has been released.');
    expect(expiryEmail?.text).toContain('Book again: https://example.com/sessions.html');
    expect(expiryEmail?.html).toContain("It's ok, you can:");
    expect(expiryEmail?.html).toContain('Book again');
    expect(expiryEmail?.text).not.toMatch(/cancelled/i);

    const rescheduleAttempt = await rescheduleBooking(expired!, {
      newStart: '2026-03-24T10:00:00.000Z',
      newEnd: '2026-03-24T11:00:00.000Z',
      timezone: 'Europe/Zurich',
    }, ctx);
    expect(rescheduleAttempt.ok).toBe(false);

    const cancelAttempt = await cancelBooking(expired!, ctx);
    expect(cancelAttempt.ok).toBe(false);
  });

  it('sends event confirmation email with Add to Google Calendar link', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00.000Z'));
    const ctx = makeCtx();
    const freeEvent = [...mockState.events.values()].find((event) => !event.is_paid)!;

    const created = await createEventBooking({
      event: freeEvent,
      firstName: 'Cal',
      lastName: 'User',
      email: 'cal-user@example.com',
      phone: '+41000000018',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');
    await confirmBookingEmail(token, ctx);

    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'event_confirmation' && email.to === 'cal-user@example.com',
    );
    expect(confirmationEmail).toBeTruthy();
    expect(confirmationEmail?.html).toContain('calendar.google.com');
    expect(confirmationEmail?.html).toContain('Add to Google Calendar');
    expect(confirmationEmail?.body).toContain('Add to calendar:');
    expect(confirmationEmail?.body).toContain('calendar.google.com');
  });

  it('initiates invoice-backed Stripe refunds during refundable cancellations and sends separate refund confirmation', async () => {
    const ctx = makeCtx();

    const created = await createPayLaterBooking({
      slotStart: '2026-04-19T10:00:00.000Z',
      slotEnd: '2026-04-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Refundable Doe',
      clientEmail: 'refund@example.com',
      clientPhone: '+41000000091',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');
    await confirmBookingEmail(token, ctx);

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await confirmBookingPayment({
      id: payment!.id,
      booking_id: payment!.booking_id,
      stripe_checkout_session_id: payment!.stripe_checkout_session_id,
      stripe_payment_intent_id: payment!.stripe_payment_intent_id,
      stripe_invoice_id: payment!.stripe_invoice_id,
      status: payment!.status,
    }, {
      paymentIntentId: 'pi_refund_invoice_123',
      invoiceId: payment!.stripe_invoice_id,
      invoiceUrl: payment!.invoice_url,
    }, ctx);

    const confirmedBooking = await ctx.providers.repository.getBookingById(created.bookingId);
    const canceled = await cancelBooking(confirmedBooking!, ctx);

    expect(canceled.ok).toBe(true);
    expect(canceled.code).toBe('CANCELED_AND_REFUNDED');
    expect(canceled.message).toContain('refund processed');
    expect(canceled.refund).toEqual(expect.objectContaining({
      status: 'SUCCEEDED',
      creditNoteUrl: expect.stringContaining('/mock-credit-note/'),
      receiptUrl: expect.stringContaining('/mock-receipt/'),
    }));

    const refundedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(refundedPayment?.status).toBe('REFUNDED');
    expect(refundedPayment?.refund_status).toBe('SUCCEEDED');
    expect(refundedPayment?.refund_amount).toBe(150);
    expect(refundedPayment?.refund_currency).toBe('CHF');
    expect(refundedPayment?.stripe_credit_note_id).toBeTruthy();
    expect(refundedPayment?.stripe_credit_note_url).toContain('/mock-credit-note/');
    expect(refundedPayment?.stripe_refund_id).toBeTruthy();
    expect(refundedPayment?.stripe_receipt_url).toContain('/mock-receipt/');
    expect(refundedPayment?.refund_reason).toContain('Full refund initiated because');
    expect(refundedPayment?.refunded_at).toBeTruthy();

    const refundEvent = mockState.bookingEvents.find(
      (event) => event.booking_id === created.bookingId && event.event_type === 'REFUND_COMPLETED',
    );
    expect(refundEvent?.payload?.['refund_path']).toBe('credit_note');

    const cancellationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_cancellation' && email.to === 'refund@example.com',
    );
    expect(cancellationEmail?.text).toContain('If a refund applies, you\'ll receive a separate confirmation email.');

    const refundEmail = mockState.sentEmails.find(
      (email) => email.kind === 'refund_confirmation' && email.to === 'refund@example.com',
    );
    expect(refundEmail?.subject).toBe('Your refund for First Clarity Session');
    expect(refundEmail?.text).toContain('Your refund has been processed and a credit note was created.');
    expect(refundEmail?.text).toContain('Amount: CHF 150.00');
    expect(refundEmail?.text).toContain('Credit note:');
    expect(refundEmail?.text).toContain('Credit note link:');
    expect(refundEmail?.text).toContain('Receipt: https://example.com/mock-receipt/');

    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cancellation_refund_provider_call_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'refund_created_via_credit_note',
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'refund_confirmation_email_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'refund_confirmation_email_sent',
      }),
    }));
  });

  it('sends event-specific cancellation copy for canceled event bookings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00.000Z'));
    const ctx = makeCtx();
    const freeEvent = [...mockState.events.values()].find((event) => !event.is_paid)!;

    const created = await createEventBooking({
      event: freeEvent,
      firstName: 'Cancel',
      lastName: 'Event',
      email: 'cancel-event@example.com',
      phone: '+41000000017',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const pending = await ctx.providers.repository.getBookingById(created.bookingId);
    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');
    const confirmed = await confirmBookingEmail(token, ctx);
    const canceled = await cancelBooking(confirmed, ctx);

    expect(canceled.ok).toBe(true);

    const cancellationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'event_cancellation' && email.to === 'cancel-event@example.com',
    );
    expect(pending?.event_id).toBeTruthy();
    expect(cancellationEmail).toBeTruthy();
    expect(cancellationEmail?.subject).toBe(`Your booking for ${freeEvent.title} has been cancelled`);
    expect(cancellationEmail?.text).toContain('We are sorry to see you go.');
    expect(cancellationEmail?.text).toContain('Your event booking for');
    expect(cancellationEmail?.text).toContain('You can always book again: https://example.com/evenings.html');
    expect(cancellationEmail?.text).toContain('Contact Yair: https://example.com/contact.html');
    expect(cancellationEmail?.text).not.toContain('Your session on');
    expect(cancellationEmail?.html).toContain('We are sorry to see you go.');
    expect(cancellationEmail?.html).toContain('You can always');
    expect(cancellationEmail?.html).toContain('Your event booking has been cancelled.');
    expect(cancellationEmail?.html).toContain('Book again');
    expect(cancellationEmail?.html).toContain('Contact Yair');
    expect(cancellationEmail?.html).toContain('Event');
  });
});
