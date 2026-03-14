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
    expect(payLaterEffects).toEqual(expect.arrayContaining(['SEND_BOOKING_CONFIRMATION_REQUEST', 'VERIFY_EMAIL_CONFIRMATION']));
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
    expect(payNowPayment?.amount_cents).toBe(11250);

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

    const submission = mockState.bookingEvents
      .filter((event) => event.booking_id === payLater.bookingId)
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    const token = String(submission?.payload?.['confirm_token'] ?? '');
    await confirmBookingEmail(token, ctx);

    const payLaterBooking = await ctx.providers.repository.getBookingById(payLater.bookingId);
    const payLaterPayment = await ctx.providers.repository.getPaymentByBookingId(payLater.bookingId);
    expect(payLaterBooking?.price).toBe(90);
    expect(payLaterBooking?.coupon_code).toBe('ISRAEL');
    expect(payLaterPayment?.amount_cents).toBe(9000);
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

    const confirmationEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_confirmation' && email.to === 'intro@example.com',
    );
    expect(confirmationEmail).toBeTruthy();
  });

  it('keeps pay-later bookings pending after email confirmation and sends payment link', async () => {
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
    expect(confirmed.current_status).toBe('PENDING');
    expect(confirmed.google_event_id).toBeNull();

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(payment?.checkout_url).toBeTruthy();

    const followupEmail = mockState.sentEmails.find(
      (email) => email.kind === 'booking_payment_due' && email.to === 'maya@example.com',
    );
    expect(followupEmail).toBeTruthy();
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
    expect(refreshedPayment?.status).toBe('SUCCEEDED');
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
      (effect) => effect.booking_id === created.bookingId && effect.effect_intent === 'VERIFY_EMAIL_CONFIRMATION',
    );
    expect(verifyEffect).toBeTruthy();
    verifyEffect!.expires_at = '2000-01-01T00:00:00.000Z';

    await runSideEffectsOutbox({ ...ctx, triggerSource: 'manual' } as any);

    const expired = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(expired?.current_status).toBe('EXPIRED');

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
