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

describe('booking domain model', () => {
  it('creates pay-now, pay-later, and free bookings with phase-2 vocabulary', async () => {
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
    expect(payLaterEffects).toEqual(expect.arrayContaining(['SEND_PAYMENT_REMINDER', 'VERIFY_STRIPE_PAYMENT']));
    expect(payLaterEffects).not.toEqual(expect.arrayContaining(['SEND_BOOKING_CONFIRMATION_REQUEST', 'VERIFY_EMAIL_CONFIRMATION']));
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
    expect(payLaterPayment?.amount).toBe(90);
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

    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'intro@example.com',
    );
    expect(confirmationEmail).toBeTruthy();
    expect(confirmationEmail?.body).toContain('Join Google Meet:');
    expect(confirmationEmail?.body).toContain(String(confirmed.meeting_link));
  });

  it('keeps pay-later bookings pending after submission and sends payment link', async () => {
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
    expect(payment?.invoice_url).toBeTruthy();

    const confirmRequestEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirm_request' && email.to === 'maya@example.com',
    );
    expect(confirmRequestEmail).toBeFalsy();

    const followupEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_payment_due' && email.to === 'maya@example.com',
    );
    expect(followupEmail).toBeTruthy();
    expect(followupEmail?.subject).toBe('Action needed: complete payment before your session');
    expect(followupEmail?.body).toContain('Please complete payment by');
    expect(followupEmail?.body).toContain('24 hours before your session');
    expect(followupEmail?.body).toContain('/continue-payment.html?token=');
    expect(followupEmail?.body).not.toContain('expire in 1 minute');
    expect(followupEmail?.body).not.toContain('Please confirm your session booking');

    const reminderEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'SEND_PAYMENT_REMINDER',
    );
    const verifyEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'VERIFY_STRIPE_PAYMENT',
    );
    expect(reminderEffect?.expires_at).toBeTruthy();
    expect(verifyEffect?.expires_at).toBeTruthy();
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'pay_later_submission_email_dispatch_decision',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'send_pay_later_submission_email',
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'pay_later_submission_email_dispatch_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'pay_later_submission_email_sent',
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
      provider_payment_id: payment!.provider_payment_id,
    }, {
      paymentIntentId: 'pi_123',
      invoiceId: 'in_123',
      invoiceUrl: 'https://invoice.example/in_123',
    }, ctx);

    const updated = await ctx.providers.repository.getBookingById(created.bookingId);
    const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(updated?.current_status).toBe('CONFIRMED');
    expect(updated?.google_event_id).toBeTruthy();
    expect(updated?.meeting_provider).toBe('google_meet');
    expect(updated?.meeting_link).toContain('https://meet.google.com/');
    expect(refreshedPayment?.status).toBe('SUCCEEDED');
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
      provider_payment_id: payment!.provider_payment_id,
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
      `https://example.com/mock-invoice/mock_inv_${payment!.provider_payment_id}.pdf`,
    );
    expect(confirmationEmail?.body).toContain(
      `Invoice: https://example.com/mock-invoice/mock_inv_${payment!.provider_payment_id}.pdf`,
    );
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'payment_settlement_invoice_resolution_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'generated_mock_invoice_url_for_settlement',
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

    const verifyEffect = mockState.sideEffects.find(
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'VERIFY_STRIPE_PAYMENT',
    );
    expect(verifyEffect).toBeTruthy();
    verifyEffect!.expires_at = '2000-01-01T00:00:00.000Z';

    await runSideEffectsOutbox({ ...ctx, triggerSource: 'manual' } as any);

    const expired = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(expired?.current_status).toBe('EXPIRED');
    const expiryEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_expired' && email.to === 'nora@example.com',
    );
    expect(expiryEmail).toBeTruthy();
    expect(expiryEmail?.subject).toBe('Your booking expired');
    expect(expiryEmail?.body).toContain('expired because it was not completed in time');
    expect(expiryEmail?.body).toContain('The slot has been released.');
    expect(expiryEmail?.body).toContain("It's ok, you can:");
    expect(expiryEmail?.body).toContain('Book again: https://example.com/sessions.html');
    expect(expiryEmail?.body).not.toMatch(/cancelled/i);

    const rescheduleAttempt = await rescheduleBooking(expired!, {
      newStart: '2026-03-24T10:00:00.000Z',
      newEnd: '2026-03-24T11:00:00.000Z',
      timezone: 'Europe/Zurich',
    }, ctx);
    expect(rescheduleAttempt.ok).toBe(false);

    const cancelAttempt = await cancelBooking(expired!, ctx);
    expect(cancelAttempt.ok).toBe(false);
  });
});
