import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStripeWebhook } from '../src/handlers/webhook.js';
import { createOperationContext } from '../src/lib/execution.js';
import { MockAntiBotProvider } from '../src/providers/antibot/mock.js';
import { MockCalendarProvider } from '../src/providers/calendar/mock.js';
import { MockEmailProvider } from '../src/providers/email/mock.js';
import { mockState } from '../src/providers/mock-state.js';
import { MockPaymentsProvider } from '../src/providers/payments/mock.js';
import { MockRepository } from '../src/providers/repository/mock.js';
import { confirmBookingEmail, createPayLaterBooking, createPayNowBooking } from '../src/services/booking-service.js';
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
  return {
    providers: {
      repository: new MockRepository(),
      email: new MockEmailProvider(),
      calendar: new MockCalendarProvider(),
      payments: new MockPaymentsProvider('https://example.com'),
      antibot: new MockAntiBotProvider(),
    } as any,
    env: makeEnv({ SITE_URL: 'https://example.com' }),
    logger: makeLogger(),
    requestId: 'req-stripe-webhook',
    correlationId: 'corr-stripe-webhook',
    operation: createOperationContext({
      appArea: 'website',
      requestId: 'req-stripe-webhook',
      correlationId: 'corr-stripe-webhook',
    }),
    executionCtx: undefined,
  } as any;
}

function getConfirmToken(bookingId: string): string {
  const submission = mockState.bookingEvents
    .filter((event) => event.booking_id === bookingId)
    .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
  return String(submission?.payload?.confirm_token ?? '');
}

beforeEach(() => {
  resetMockState();
});

describe('Stripe webhook handling', () => {
  it('uses the sandbox webhook secret when payments mode is stripe_sandbox', async () => {
    const ctx = makeCtx();
    ctx.env.PAYMENTS_MODE = 'stripe_sandbox';
    ctx.env.STRIPE_WEBHOOK_SECRET_SANDBOX = 'whsec_sandbox_123';
    ctx.providers.payments.parseWebhookEvent = vi.fn().mockResolvedValue(null);

    const response = await handleStripeWebhook(
      new Request('https://api.local/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 'mock' },
        body: '{}',
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(ctx.providers.payments.parseWebhookEvent).toHaveBeenCalledWith(
      '{}',
      'mock',
      'whsec_sandbox_123',
    );
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'stripe_webhook_secret_selection_decision',
      context: expect.objectContaining({
        stripe_runtime_mode: 'stripe_sandbox',
        stripe_webhook_secret_present: true,
        branch_taken: 'use_selected_stripe_runtime_webhook_secret',
      }),
    }));
  });

  it('settles pay-now bookings via checkout session reconciliation', async () => {
    const ctx = makeCtx();
    const created = await createPayNowBooking({
      slotStart: '2026-03-26T10:00:00.000Z',
      slotEnd: '2026-03-26T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Webhook Pay Now',
      clientEmail: 'webhook-pay-now@example.com',
      clientPhone: '+41000000071',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    ctx.providers.payments.parseWebhookEvent = vi.fn().mockResolvedValue({
      eventType: 'checkout.session.completed',
      checkoutSessionId: payment!.stripe_checkout_session_id,
      paymentIntentId: 'pi_checkout_123',
      invoiceId: null,
      invoiceUrl: null,
      paymentLinkId: null,
      amount: payment!.amount,
      currency: payment!.currency,
      bookingId: created.bookingId,
      customerId: payment!.stripe_customer_id,
      rawPayload: { type: 'checkout.session.completed' },
    });

    const response = await handleStripeWebhook(
      new Request('https://api.local/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 'mock' },
        body: '{}',
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    const refreshedBooking = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(refreshedPayment?.status).toBe('SUCCEEDED');
    expect(refreshedPayment?.stripe_payment_intent_id).toBe('pi_checkout_123');
    expect(refreshedBooking?.current_status).toBe('CONFIRMED');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'stripe_webhook_request_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'payment_settled_via_shared_path',
      }),
    }));
  });

  it('settles pay-later bookings via invoice reconciliation', async () => {
    const ctx = makeCtx();
    const created = await createPayLaterBooking({
      slotStart: '2026-03-22T10:00:00.000Z',
      slotEnd: '2026-03-22T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Webhook Pay Later',
      clientEmail: 'webhook-pay-later@example.com',
      clientPhone: '+41000000072',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    await confirmBookingEmail(getConfirmToken(created.bookingId), ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    ctx.providers.payments.parseWebhookEvent = vi.fn().mockResolvedValue({
      eventType: 'invoice.paid',
      checkoutSessionId: null,
      paymentIntentId: 'pi_invoice_123',
      invoiceId: payment!.stripe_invoice_id,
      invoiceUrl: payment!.invoice_url,
      paymentLinkId: null,
      amount: payment!.amount,
      currency: payment!.currency,
      bookingId: created.bookingId,
      customerId: payment!.stripe_customer_id,
      rawPayload: { type: 'invoice.paid' },
    });

    const response = await handleStripeWebhook(
      new Request('https://api.local/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 'mock' },
        body: '{}',
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    const refreshedBooking = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(refreshedPayment?.status).toBe('SUCCEEDED');
    expect(refreshedPayment?.stripe_payment_intent_id).toBe('pi_invoice_123');
    expect(refreshedBooking?.current_status).toBe('CONFIRMED');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'stripe_webhook_request_completed',
      context: expect.objectContaining({
        stripe_event_type: 'invoice.paid',
        branch_taken: 'payment_settled_via_shared_path',
      }),
    }));
  });

  it('falls back from payment intent to booking id for pay-now webhook settlement', async () => {
    const ctx = makeCtx();
    const created = await createPayNowBooking({
      slotStart: '2026-03-27T10:00:00.000Z',
      slotEnd: '2026-03-27T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Webhook PI Pay Now',
      clientEmail: 'webhook-pi-pay-now@example.com',
      clientPhone: '+41000000073',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(payment?.stripe_payment_intent_id).toBeNull();
    ctx.providers.payments.parseWebhookEvent = vi.fn().mockResolvedValue({
      eventType: 'payment_intent.succeeded',
      checkoutSessionId: null,
      paymentIntentId: 'pi_checkout_fallback_123',
      invoiceId: null,
      invoiceUrl: null,
      paymentLinkId: null,
      amount: payment!.amount,
      currency: payment!.currency,
      bookingId: created.bookingId,
      customerId: payment!.stripe_customer_id,
      rawPayload: { type: 'payment_intent.succeeded' },
    });

    const response = await handleStripeWebhook(
      new Request('https://api.local/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 'mock' },
        body: '{}',
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    const refreshedBooking = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(refreshedPayment?.status).toBe('SUCCEEDED');
    expect(refreshedPayment?.stripe_payment_intent_id).toBe('pi_checkout_fallback_123');
    expect(refreshedBooking?.current_status).toBe('CONFIRMED');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'stripe_webhook_payment_lookup_completed',
      context: expect.objectContaining({
        payment_id: payment!.id,
        branch_taken: 'match_booking_id_fallback_for_payment_intent',
      }),
    }));
  });

  it('uses invoice id as the primary pay-later match before payment intent fallback', async () => {
    const ctx = makeCtx();
    const created = await createPayLaterBooking({
      slotStart: '2026-03-28T10:00:00.000Z',
      slotEnd: '2026-03-28T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Webhook PI Pay Later',
      clientEmail: 'webhook-pi-pay-later@example.com',
      clientPhone: '+41000000074',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    await confirmBookingEmail(getConfirmToken(created.bookingId), ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(payment?.stripe_payment_intent_id).toBeNull();
    ctx.providers.payments.parseWebhookEvent = vi.fn().mockResolvedValue({
      eventType: 'payment_intent.succeeded',
      checkoutSessionId: null,
      paymentIntentId: 'pi_invoice_primary_123',
      invoiceId: payment!.stripe_invoice_id,
      invoiceUrl: payment!.invoice_url,
      paymentLinkId: null,
      amount: payment!.amount,
      currency: payment!.currency,
      bookingId: created.bookingId,
      customerId: payment!.stripe_customer_id,
      rawPayload: { type: 'payment_intent.succeeded' },
    });

    const response = await handleStripeWebhook(
      new Request('https://api.local/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 'mock' },
        body: '{}',
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    const refreshedBooking = await ctx.providers.repository.getBookingById(created.bookingId);
    expect(refreshedPayment?.status).toBe('SUCCEEDED');
    expect(refreshedPayment?.stripe_payment_intent_id).toBe('pi_invoice_primary_123');
    expect(refreshedBooking?.current_status).toBe('CONFIRMED');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'stripe_webhook_payment_lookup_completed',
      context: expect.objectContaining({
        payment_id: payment!.id,
        branch_taken: 'match_invoice_primary_for_payment_intent',
      }),
    }));
  });
});
