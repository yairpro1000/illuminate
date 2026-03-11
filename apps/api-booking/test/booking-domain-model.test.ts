import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { MockRepository } from '../src/providers/repository/mock.js';
import { MockEmailProvider } from '../src/providers/email/mock.js';
import { MockCalendarProvider } from '../src/providers/calendar/mock.js';
import { MockPaymentsProvider } from '../src/providers/payments/mock.js';
import { MockAntiBotProvider } from '../src/providers/antibot/mock.js';
import { mockState } from '../src/providers/mock-state.js';

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

function makeCtx(overrides?: {
  email?: any;
  calendar?: any;
}) {
  const repository = new MockRepository();
  const providers = {
    repository,
    email: overrides?.email ?? new MockEmailProvider(),
    calendar: overrides?.calendar ?? new MockCalendarProvider(),
    payments: new MockPaymentsProvider('https://example.com'),
    antibot: new MockAntiBotProvider(),
  } as any;

  const env = {
    SITE_URL: 'https://example.com',
    SESSION_ADDRESS: 'Somewhere 1, Zurich',
    SESSION_MAPS_URL: 'https://maps.example',
    TIMEZONE: 'Europe/Zurich',
  } as any;

  const logger = {
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureException: vi.fn(),
  } as any;

  return {
    providers,
    env,
    logger,
    requestId: 'req-1',
  };
}

function iso(date: string) {
  return new Date(date).toISOString();
}

beforeEach(() => {
  resetMockState();
});

describe('booking domain model', () => {
  it('creates bookings for free, pay-now, and pay-later with canonical events/effects', async () => {
    const ctx = makeCtx();

    const payNow = await createPayNowBooking(
      {
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
      },
      ctx,
    );

    const payLater = await createPayLaterBooking(
      {
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
      },
      ctx,
    );

    const freeEvent = [...mockState.events.values()].find((event) => !event.is_paid)!;
    const free = await createEventBooking(
      {
        event: freeEvent,
        firstName: 'Alice',
        lastName: 'Example',
        email: 'alice@example.com',
        phone: '+41000000003',
        reminderEmailOptIn: true,
        reminderWhatsappOptIn: false,
        turnstileToken: 'ok',
        remoteIp: null,
      },
      ctx,
    );

    expect(payLater.status).toBe('PENDING_CONFIRMATION');
    expect(free.status).toBe('PENDING_CONFIRMATION');
    expect(payNow.checkoutUrl).toContain('session_id=');

    const payNowEventTypes = mockState.bookingEvents
      .filter((event) => event.booking_id === payNow.bookingId)
      .map((event) => event.event_type);
    expect(payNowEventTypes).toContain('BOOKING_FORM_SUBMITTED_PAY_NOW');

    const payNowEffects = mockState.sideEffects
      .filter((effect) => effect.booking_id === payNow.bookingId)
      .map((effect) => effect.effect_intent);
    expect(payNowEffects).toEqual(expect.arrayContaining(['create_stripe_checkout', 'send_payment_link', 'expire_booking']));
    expect(payNowEffects).not.toContain('reserve_slot');

    const payNowAttempts = mockState.sideEffectAttempts.filter((attempt) => {
      const effect = mockState.sideEffects.find((candidate) => candidate.id === attempt.booking_side_effect_id);
      return effect?.booking_id === payNow.bookingId;
    });
    expect(payNowAttempts.some((attempt) => attempt.status === 'success')).toBe(true);

    const payLaterEventTypes = mockState.bookingEvents
      .filter((event) => event.booking_id === payLater.bookingId)
      .map((event) => event.event_type);
    expect(payLaterEventTypes).toContain('BOOKING_FORM_SUBMITTED_PAY_LATER');
    const payLaterConfirmationEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === payLater.bookingId && effect.effect_intent === 'send_email_confirmation',
    );
    expect(payLaterConfirmationEffect?.status).toBe('success');
    const payLaterConfirmationAttempts = mockState.sideEffectAttempts.filter(
      (attempt) => attempt.booking_side_effect_id === payLaterConfirmationEffect?.id,
    );
    expect(payLaterConfirmationAttempts.map((attempt) => attempt.status)).toEqual(['success']);

    const freeEventTypes = mockState.bookingEvents
      .filter((event) => event.booking_id === free.bookingId)
      .map((event) => event.event_type);
    expect(freeEventTypes).toContain('BOOKING_FORM_SUBMITTED_FREE');
  });

  it('confirms email and updates cached status with canonical event row', async () => {
    const ctx = makeCtx();

    const created = await createPayLaterBooking(
      {
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
      },
      ctx,
    );

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED_PAY_LATER');

    const token = String(submission?.payload?.['confirm_token'] ?? '');
    expect(token).toBeTruthy();

    const confirmed = await confirmBookingEmail(token, ctx);
    expect(confirmed.current_status).toBe('SLOT_CONFIRMED');
    expect(confirmed.google_event_id).toBeTruthy();

    const eventTypes = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .map((event) => event.event_type);
    expect(eventTypes).toContain('EMAIL_CONFIRMED');
    expect(eventTypes).toContain('SLOT_CONFIRMED');

    const intents = mockState.sideEffects
      .filter((effect) => effect.booking_id === created.bookingId)
      .map((effect) => effect.effect_intent);
    expect(intents).toContain('reserve_slot');

    const confirmationReservationEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'reserve_slot',
    );
    expect(confirmationReservationEffect?.status).toBe('success');

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(payment?.checkout_url).toBeTruthy();
    const finalConfirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'maya@example.com',
    );
    expect(finalConfirmationEmail).toBeTruthy();
    expect(finalConfirmationEmail?.subject).toContain('is confirmed');
    expect(finalConfirmationEmail?.body).toContain('Your session is confirmed.');
    expect(finalConfirmationEmail?.body).toContain('Session: ');
    expect(finalConfirmationEmail?.body).toContain('Time: ');
    expect(finalConfirmationEmail?.body).toContain('A calendar invitation has been sent to you.');
    expect(finalConfirmationEmail?.body).toContain('Need to reschedule or cancel?');
    expect(finalConfirmationEmail?.body).toContain('Manage booking: https://example.com/manage.html?token=');
    expect(finalConfirmationEmail?.body).toContain('Complete payment:');
    expect(finalConfirmationEmail?.body).toContain(payment?.checkout_url ?? '');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_confirmation_email_dispatch_decision',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'allow_confirmation_email_dispatch',
        deny_reason: null,
        has_google_event_id: true,
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_confirmation_email_dispatch_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'session_confirmation_email_sent',
      }),
    }));
  });

  it('rejects pay-later confirmation when token is older than 15 minutes', async () => {
    const ctx = makeCtx();

    const created = await createPayLaterBooking(
      {
        slotStart: '2026-03-19T13:00:00.000Z',
        slotEnd: '2026-03-19T14:00:00.000Z',
        timezone: 'Europe/Zurich',
        sessionType: 'session',
        clientName: 'Expired Token Doe',
        clientEmail: 'expired-token@example.com',
        clientPhone: '+41000000009',
        reminderEmailOptIn: true,
        reminderWhatsappOptIn: false,
        turnstileToken: 'ok',
        remoteIp: null,
      },
      ctx,
    );

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED_PAY_LATER');
    expect(submission).toBeTruthy();
    submission!.created_at = new Date(Date.now() - 16 * 60_000).toISOString();

    const token = String(submission?.payload?.['confirm_token'] ?? '');
    await expect(confirmBookingEmail(token, ctx)).rejects.toThrow('no longer valid');
  });

  it('reserves intro (free) session slots only after email confirmation', async () => {
    const ctx = makeCtx();

    const created = await createPayLaterBooking(
      {
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
      },
      ctx,
    );

    const createdBooking = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(createdBooking?.google_event_id).toBeNull();

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED_FREE');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    const confirmed = await confirmBookingEmail(token, ctx);
    expect(confirmed.google_event_id).toBeTruthy();
    expect(confirmed.current_status).toBe('SLOT_CONFIRMED');

    const introConfirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'intro@example.com',
    );
    expect(introConfirmationEmail).toBeTruthy();
    expect(introConfirmationEmail?.body).toContain('Session: ');
    expect(introConfirmationEmail?.body).toContain('A calendar invitation has been sent to you.');
    expect(introConfirmationEmail?.body).toContain('Manage booking: https://example.com/manage.html?token=');
    expect(introConfirmationEmail?.body).not.toContain('Complete payment:');
  });

  it('sends free-event confirmation email immediately after email confirmation', async () => {
    const ctx = makeCtx();
    const freeEvent = [...mockState.events.values()].find((event) => !event.is_paid)!;

    const created = await createEventBooking(
      {
        event: freeEvent,
        firstName: 'Event',
        lastName: 'Guest',
        email: 'event-guest@example.com',
        phone: '+41000000018',
        reminderEmailOptIn: true,
        reminderWhatsappOptIn: false,
        turnstileToken: 'ok',
        remoteIp: null,
      },
      ctx,
    );

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED_FREE');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    const confirmed = await confirmBookingEmail(token, ctx);
    expect(confirmed.current_status).toBe('SLOT_CONFIRMED');

    const eventConfirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'event_confirmation' && email.to === 'event-guest@example.com',
    );
    expect(eventConfirmationEmail).toBeTruthy();
    expect(eventConfirmationEmail?.body).toContain('Manage: https://example.com/manage.html?token=');
  });

  it('reserves pay-now slots immediately on payment success', async () => {
    const ctx = makeCtx();

    const created = await createPayNowBooking(
      {
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
      },
      ctx,
    );

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(payment).toBeTruthy();
    const beforeSettlement = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(beforeSettlement?.current_status).toBe('PENDING_CONFIRMATION');
    expect(beforeSettlement?.google_event_id).toBeNull();

    await confirmBookingPayment(
      {
        id: payment!.id,
        booking_id: payment!.booking_id,
        provider_payment_id: payment!.provider_payment_id,
      },
      {
        paymentIntentId: 'pi_123',
        invoiceId: 'in_123',
        invoiceUrl: 'https://invoice.example/in_123',
      },
      ctx,
    );

    const updated = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(updated?.current_status).toBe('PAID');
    expect(updated?.google_event_id).toBeTruthy();

    const sendConfirmationEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'send_booking_confirmation',
    );
    expect(sendConfirmationEffect?.status).toBe('success');

    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'paid@example.com',
    );
    expect(confirmationEmail).toBeTruthy();
  });

  it('records a calendar retryable failure when immediate reservation fails', async () => {
    const ctx = makeCtx({
      calendar: {
        getBusyTimes: vi.fn().mockResolvedValue([]),
        createEvent: vi.fn().mockRejectedValue(new Error('Google createEvent failed (400): Invalid resource id value.')),
        updateEvent: vi.fn().mockResolvedValue(undefined),
        deleteEvent: vi.fn().mockResolvedValue(undefined),
      },
    });

    const created = await createPayLaterBooking(
      {
        slotStart: '2026-03-27T10:00:00.000Z',
        slotEnd: '2026-03-27T11:00:00.000Z',
        timezone: 'Europe/Zurich',
        sessionType: 'session',
        clientName: 'Failure Doe',
        clientEmail: 'failure@example.com',
        clientPhone: '+41000000016',
        reminderEmailOptIn: true,
        reminderWhatsappOptIn: false,
        turnstileToken: 'ok',
        remoteIp: null,
      },
      ctx,
    );

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED_PAY_LATER');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    const confirmed = await confirmBookingEmail(token, ctx);

    expect(confirmed.current_status).toBe('SLOT_CONFIRMED');
    expect(confirmed.google_event_id).toBeNull();
    const reserveEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'reserve_slot',
    );
    expect(reserveEffect?.status).toBe('failed');
    const reserveAttempts = mockState.sideEffectAttempts.filter(
      (attempt) => attempt.booking_side_effect_id === reserveEffect?.id,
    );
    expect(reserveAttempts.map((attempt) => attempt.status)).toEqual(['fail']);
    expect(reserveAttempts[0]?.error_message).toContain('Invalid resource id value');
    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'calendar_reservation_attempt_completed',
      context: expect.objectContaining({
        branch_taken: 'side_effect_failed_recorded_for_retry',
      }),
    }));

    const opsAlertEmail = mockState.sentEmails.find((email) =>
      email.kind === 'contact_message' &&
      email.to === 'hello@yairb.ch' &&
      email.body.includes('calendar_reservation_failure'),
    );
    expect(opsAlertEmail).toBeTruthy();
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_email_confirmation_sync_outcome',
      context: expect.objectContaining({
        branch_taken: 'confirmation_completed_calendar_sync_pending_retry',
      }),
    }));
  });

  it('records failed immediate confirmation email attempt and keeps retry path', async () => {
    const emailProvider = {
      sendBookingConfirmRequest: vi.fn().mockRejectedValue(new Error('smtp temporary outage')),
      sendEventConfirmRequest: vi.fn().mockResolvedValue(undefined),
    } as any;

    const ctx = makeCtx({ email: emailProvider });

    const created = await createPayLaterBooking(
      {
        slotStart: '2026-03-29T10:00:00.000Z',
        slotEnd: '2026-03-29T11:00:00.000Z',
        timezone: 'Europe/Zurich',
        sessionType: 'session',
        clientName: 'Email Retry Doe',
        clientEmail: 'email-retry@example.com',
        clientPhone: '+41000000017',
        reminderEmailOptIn: true,
        reminderWhatsappOptIn: false,
        turnstileToken: 'ok',
        remoteIp: null,
      },
      ctx,
    );

    const confirmationEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'send_email_confirmation',
    );
    expect(confirmationEffect?.status).toBe('failed');

    const confirmationAttempts = mockState.sideEffectAttempts.filter(
      (attempt) => attempt.booking_side_effect_id === confirmationEffect?.id,
    );
    expect(confirmationAttempts.map((attempt) => attempt.status)).toEqual(['fail']);
    expect(confirmationAttempts[0]?.error_message).toContain('smtp temporary outage');

    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'realtime_side_effect_attempt_completed',
      context: expect.objectContaining({
        side_effect_intent: 'send_email_confirmation',
        branch_taken: 'realtime_side_effect_failed_recorded_for_retry',
      }),
    }));
  });

  it('expires pending confirmation bookings when expire_booking effect is due', async () => {
    const ctx = makeCtx();

    const created = await createPayLaterBooking(
      {
        slotStart: '2026-03-20T10:00:00.000Z',
        slotEnd: '2026-03-20T11:00:00.000Z',
        timezone: 'Europe/Zurich',
        sessionType: 'session',
        clientName: 'Leo Doe',
        clientEmail: 'leo@example.com',
        clientPhone: '+41000000005',
        reminderEmailOptIn: true,
        reminderWhatsappOptIn: false,
        turnstileToken: 'ok',
        remoteIp: null,
      },
      ctx,
    );

    const expireEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'expire_booking',
    );
    expect(expireEffect).toBeTruthy();
    expireEffect!.expires_at = '2000-01-01T00:00:00.000Z';

    await runSideEffectsOutbox({ ...ctx, triggerSource: 'manual' } as any);

    const booking = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(booking?.current_status).toBe('EXPIRED');

    const eventTypes = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .map((event) => event.event_type);
    expect(eventTypes).toContain('BOOKING_EXPIRED');

    const cancelReservedSlotEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'cancel_reserved_slot',
    );
    const failedNotificationEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'send_booking_failed_notification',
    );
    expect(cancelReservedSlotEffect?.status).toBe('success');
    expect(failedNotificationEffect?.status).toBe('success');

    const expiryEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_cancellation' && email.to === 'leo@example.com',
    );
    expect(expiryEmail).toBeTruthy();
    expect(expiryEmail?.body).toContain('Start a new booking: https://example.com/book.html');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'booking_expiry_notification_sync_outcome',
      context: expect.objectContaining({
        branch_taken: 'expiry_notification_intent_executed_or_queued',
      }),
    }));
  });

  it('schedules payment reminder at starts_at minus 24h after slot confirmation', async () => {
    const ctx = makeCtx();

    const created = await createPayLaterBooking(
      {
        slotStart: '2026-03-22T10:00:00.000Z',
        slotEnd: '2026-03-22T11:00:00.000Z',
        timezone: 'Europe/Zurich',
        sessionType: 'session',
        clientName: 'Rita Doe',
        clientEmail: 'rita@example.com',
        clientPhone: '+41000000006',
        reminderEmailOptIn: true,
        reminderWhatsappOptIn: false,
        turnstileToken: 'ok',
        remoteIp: null,
      },
      ctx,
    );

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED_PAY_LATER');
    const token = String(submission?.payload?.['confirm_token'] ?? '');

    await confirmBookingEmail(token, ctx);
    await runSideEffectsOutbox({ ...ctx, triggerSource: 'manual' } as any);

    const paymentReminder = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'send_payment_reminder',
    );

    expect(paymentReminder).toBeTruthy();
    expect(paymentReminder?.expires_at).toBe(iso('2026-03-21T10:00:00.000Z'));
  });

  it('records reschedule and cancel flows as events and side effects while updating status cache', async () => {
    const ctx = makeCtx();

    const created = await createPayLaterBooking(
      {
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
      },
      ctx,
    );

    const booking = await ctx.providers.repository.getBookingById(created.bookingId);
    const rescheduledResult = await rescheduleBooking(
      booking!,
      {
        newStart: '2026-03-24T10:00:00.000Z',
        newEnd: '2026-03-24T11:00:00.000Z',
        timezone: 'Europe/Zurich',
      },
      ctx,
    );
    expect(rescheduledResult.ok).toBe(true);
    const rescheduled = rescheduledResult.booking;

    expect(rescheduled.starts_at).toBe('2026-03-24T10:00:00.000Z');

    const canceledResult = await cancelBooking(rescheduled, ctx);
    expect(canceledResult.ok).toBe(true);

    const refreshed = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(refreshed?.current_status).toBe('CANCELED');

    const eventTypes = mockState.bookingEvents
      .filter((event) => event.booking_id === created.bookingId)
      .map((event) => event.event_type);
    expect(eventTypes).toEqual(expect.arrayContaining(['BOOKING_RESCHEDULED', 'BOOKING_CANCELED']));

    const intents = mockState.sideEffects
      .filter((effect) => effect.booking_id === created.bookingId)
      .map((effect) => effect.effect_intent);
    expect(intents).toEqual(expect.arrayContaining(['update_reserved_slot', 'cancel_reserved_slot']));

    const updateReservedSlotEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'update_reserved_slot',
    );
    const cancelReservedSlotEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'cancel_reserved_slot',
    );
    const cancellationEmailEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'send_booking_cancellation_confirmation',
    );
    expect(updateReservedSlotEffect?.status).toBe('success');
    expect(cancelReservedSlotEffect?.status).toBe('success');
    expect(cancellationEmailEffect?.status).toBe('success');
  });

  it('tracks side-effect retry attempts, eventual success, and dead-path exhaustion', async () => {
    const emailProvider = {
      sendBookingPaymentReminder: vi
        .fn()
        .mockRejectedValueOnce(new Error('smtp temporary'))
        .mockResolvedValueOnce(undefined),
      sendBookingCancellation: vi.fn().mockResolvedValue(undefined),
      sendBookingConfirmRequest: vi.fn().mockResolvedValue(undefined),
      sendEventConfirmRequest: vi.fn().mockResolvedValue(undefined),
      sendBookingPaymentDue: vi.fn().mockResolvedValue(undefined),
      sendEventFollowup: vi.fn().mockResolvedValue(undefined),
      sendBookingReminder24h: vi.fn().mockResolvedValue(undefined),
      sendEventReminder24h: vi.fn().mockResolvedValue(undefined),
    } as any;

    const ctx = makeCtx({ email: emailProvider });

    const payNow = await createPayNowBooking(
      {
        slotStart: '2026-03-25T10:00:00.000Z',
        slotEnd: '2026-03-25T11:00:00.000Z',
        timezone: 'Europe/Zurich',
        sessionType: 'session',
        clientName: 'Retry Doe',
        clientEmail: 'retry@example.com',
        clientPhone: '+41000000008',
        reminderEmailOptIn: true,
        reminderWhatsappOptIn: false,
        turnstileToken: 'ok',
        remoteIp: null,
      },
      ctx,
    );

    const triggerEvent = mockState.bookingEvents.find((event) => event.booking_id === payNow.bookingId)!;
    const [retryEffect] = await ctx.providers.repository.createBookingSideEffects([
      {
        booking_event_id: triggerEvent.id,
        entity: 'email',
        effect_intent: 'send_payment_reminder',
        status: 'pending',
        expires_at: null,
        max_attempts: 2,
      },
    ]);

    await runSideEffectsOutbox({ ...ctx, triggerSource: 'manual' } as any);
    await runSideEffectsOutbox({ ...ctx, triggerSource: 'manual' } as any);
    const retryUpdated = mockState.sideEffects.find((effect) => effect.id === retryEffect!.id)!;
    const retryAttempts = mockState.sideEffectAttempts.filter(
      (attempt) => attempt.booking_side_effect_id === retryUpdated.id,
    );

    expect(retryUpdated.status).toBe('success');
    expect(retryAttempts.map((attempt) => attempt.status)).toEqual(['fail', 'success']);

    emailProvider.sendBookingPaymentReminder.mockReset();
    emailProvider.sendBookingPaymentReminder.mockRejectedValue(new Error('smtp permanent'));

    const [deadEffect] = await ctx.providers.repository.createBookingSideEffects([
      {
        booking_event_id: triggerEvent.id,
        entity: 'email',
        effect_intent: 'send_payment_reminder',
        status: 'pending',
        expires_at: null,
        max_attempts: 1,
      },
    ]);

    await runSideEffectsOutbox({ ...ctx, triggerSource: 'manual' } as any);
    const deadUpdated = mockState.sideEffects.find((effect) => effect.id === deadEffect!.id)!;
    const deadAttempts = mockState.sideEffectAttempts.filter((attempt) => attempt.booking_side_effect_id === deadUpdated.id);

    expect(deadUpdated.status).toBe('dead');
    expect(deadAttempts.map((attempt) => attempt.status)).toEqual(['fail']);
  });
});
