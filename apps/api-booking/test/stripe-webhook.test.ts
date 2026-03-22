import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStripeWebhook } from '../src/handlers/webhook.js';
import { createOperationContext } from '../src/lib/execution.js';
import { MockAntiBotProvider } from '../src/providers/antibot/mock.js';
import { MockCalendarProvider } from '../src/providers/calendar/mock.js';
import { MockEmailProvider } from '../src/providers/email/mock.js';
import { mockState } from '../src/providers/mock-state.js';
import { MockPaymentsProvider } from '../src/providers/payments/mock.js';
import { MockRepository } from '../src/providers/repository/mock.js';
import { cancelBooking, confirmBookingEmail, confirmBookingPayment, createPayLaterBooking, createPayNowBooking } from '../src/services/booking-service.js';
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
    siteUrl: 'https://example.com',
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
      eventCategory: 'payment',
      eventType: 'checkout.session.completed',
      checkoutSessionId: payment!.stripe_checkout_session_id,
      paymentIntentId: 'pi_checkout_123',
      invoiceId: null,
      invoiceUrl: null,
      paymentLinkId: null,
      receiptUrl: null,
      amount: payment!.amount,
      currency: payment!.currency,
      bookingId: created.bookingId,
      customerId: payment!.stripe_customer_id,
      siteUrl: null,
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

  it('backfills invoice artifacts for a settled sandbox pay-now payment when invoice.paid arrives later', async () => {
    const ctx = makeCtx();
    ctx.env.PAYMENTS_MODE = 'stripe_sandbox';
    ctx.providers.payments.getPaymentArtifactDetails = vi.fn().mockResolvedValue({
      invoiceId: null,
      invoiceUrl: null,
      paymentIntentId: null,
      paymentLinkId: null,
      chargeId: null,
      receiptUrl: null,
      rawPayload: null,
    });
    ctx.providers.payments.createCheckoutSession = vi.fn().mockResolvedValue({
      sessionId: 'cs_test_checkout_invoice_123',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_checkout_invoice_123',
      amount: 150,
      currency: 'CHF',
      customerId: 'cus_test_invoice_123',
      paymentIntentId: null,
      rawPayload: { id: 'cs_test_checkout_invoice_123' },
    });

    const created = await createPayNowBooking({
      slotStart: '2026-03-26T12:00:00.000Z',
      slotEnd: '2026-03-26T13:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Webhook Backfill',
      clientEmail: 'webhook-backfill@example.com',
      clientPhone: '+41000000079',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);

    ctx.providers.payments.parseWebhookEvent = vi.fn()
      .mockResolvedValueOnce({
        eventCategory: 'payment',
        eventType: 'checkout.session.completed',
        checkoutSessionId: payment!.stripe_checkout_session_id,
        paymentIntentId: 'pi_test_checkout_invoice_123',
        invoiceId: null,
        invoiceUrl: null,
        paymentLinkId: null,
        receiptUrl: null,
        amount: payment!.amount,
        currency: payment!.currency,
        bookingId: created.bookingId,
        customerId: payment!.stripe_customer_id,
        siteUrl: null,
        rawPayload: { type: 'checkout.session.completed' },
      })
      .mockResolvedValueOnce({
        eventCategory: 'refund',
        eventType: 'refund.updated',
        refundId: 're_test_checkout_invoice_123',
        creditNoteId: null,
        creditNoteNumber: null,
        creditNoteDocumentUrl: null,
        receiptUrl: null,
        paymentIntentId: 'pi_test_checkout_invoice_123',
        invoiceId: null,
        refundStatus: 'SUCCEEDED',
        amount: payment!.amount,
        currency: payment!.currency,
        bookingId: created.bookingId,
        rawPayload: { type: 'refund.updated' },
      })
      .mockResolvedValueOnce({
        eventCategory: 'payment',
        eventType: 'invoice.paid',
        checkoutSessionId: null,
        paymentIntentId: 'pi_test_checkout_invoice_123',
        invoiceId: 'in_test_checkout_invoice_123',
        invoiceUrl: 'https://invoice.example/in_test_checkout_invoice_123',
        paymentLinkId: null,
        receiptUrl: 'https://pay.stripe.com/receipts/ch_test_checkout_invoice_123',
        amount: payment!.amount,
        currency: payment!.currency,
        bookingId: created.bookingId,
        customerId: payment!.stripe_customer_id,
        siteUrl: null,
        rawPayload: { type: 'invoice.paid' },
      });

    const makeWebhookRequest = () => new Request('https://api.local/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'mock' },
      body: '{}',
    });

    const firstResponse = await handleStripeWebhook(makeWebhookRequest(), ctx);
    expect(firstResponse.status).toBe(200);

    const afterCheckoutSettlement = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(afterCheckoutSettlement?.status).toBe('SUCCEEDED');
    expect(afterCheckoutSettlement?.invoice_url).toBeNull();

    const paymentSettledEventsBeforeBackfill = mockState.bookingEvents.filter(
      (event) => event.booking_id === created.bookingId && event.event_type === 'PAYMENT_SETTLED',
    );
    const confirmationEmailsBeforeBackfill = mockState.sentEmails.filter(
      (email) => email.kind === 'booking_confirmation' && email.to === 'webhook-backfill@example.com',
    );

    const secondResponse = await handleStripeWebhook(makeWebhookRequest(), ctx);
    expect(secondResponse.status).toBe(200);

    const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(refreshedPayment?.status).toBe('SUCCEEDED');
    expect(refreshedPayment?.refund_status ?? 'NONE').toBe('NONE');
    expect(refreshedPayment?.stripe_refund_id ?? null).toBeNull();
    expect(refreshedPayment?.stripe_payment_intent_id).toBe('pi_test_checkout_invoice_123');
    expect(refreshedPayment?.stripe_invoice_id ?? null).toBeNull();
    expect(refreshedPayment?.invoice_url).toBeNull();
    expect(
      mockState.bookingEvents.filter(
        (event) => event.booking_id === created.bookingId && event.event_type === 'PAYMENT_SETTLED',
      ),
    ).toHaveLength(paymentSettledEventsBeforeBackfill.length);
    expect(
      mockState.sentEmails.filter(
        (email) => email.kind === 'booking_confirmation' && email.to === 'webhook-backfill@example.com',
      ),
    ).toHaveLength(confirmationEmailsBeforeBackfill.length);
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'stripe_webhook_request_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'skip_refund_webhook_without_local_initiation',
        deny_reason: 'refund_not_initiated_locally',
      }),
    }));

    const thirdResponse = await handleStripeWebhook(makeWebhookRequest(), ctx);
    expect(thirdResponse.status).toBe(200);

    const invoiceBackfilledPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(invoiceBackfilledPayment?.stripe_invoice_id).toBe('in_test_checkout_invoice_123');
    expect(invoiceBackfilledPayment?.invoice_url).toBe('https://invoice.example/in_test_checkout_invoice_123');
    expect(invoiceBackfilledPayment?.stripe_receipt_url).toBe('https://pay.stripe.com/receipts/ch_test_checkout_invoice_123');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'payment_succeeded_artifact_backfill_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'reuse_upstream_invoice_url',
        resolved_invoice_url_present: true,
      }),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'stripe_webhook_request_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'backfilled_invoice_artifacts_for_succeeded_payment',
      }),
    }));
  });

  it('reconciles locally initiated refund webhooks into refund completion and email dispatch', async () => {
    const ctx = makeCtx();
    const created = await createPayNowBooking({
      slotStart: '2026-03-27T14:00:00.000Z',
      slotEnd: '2026-03-27T15:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Webhook Refund',
      clientEmail: 'webhook-refund@example.com',
      clientPhone: '+41000000080',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);

    ctx.providers.payments.parseWebhookEvent = vi.fn()
      .mockResolvedValueOnce({
        eventCategory: 'payment',
        eventType: 'checkout.session.completed',
        checkoutSessionId: payment!.stripe_checkout_session_id,
        paymentIntentId: 'pi_refund_webhook_123',
        invoiceId: null,
        invoiceUrl: null,
        paymentLinkId: null,
        receiptUrl: null,
        amount: payment!.amount,
        currency: payment!.currency,
        bookingId: created.bookingId,
        customerId: payment!.stripe_customer_id,
        siteUrl: null,
        rawPayload: { type: 'checkout.session.completed' },
      })
      .mockResolvedValueOnce({
        eventCategory: 'refund',
        eventType: 'refund.updated',
        refundId: 're_local_refund_123',
        creditNoteId: null,
        creditNoteNumber: null,
        creditNoteDocumentUrl: null,
        receiptUrl: 'https://pay.stripe.com/receipts/ch_local_refund_123',
        paymentIntentId: 'pi_refund_webhook_123',
        invoiceId: null,
        refundStatus: 'SUCCEEDED',
        amount: payment!.amount,
        currency: payment!.currency,
        bookingId: created.bookingId,
        rawPayload: { type: 'refund.updated' },
      })
      .mockResolvedValueOnce({
        eventCategory: 'refund',
        eventType: 'refund.updated',
        refundId: 're_local_refund_123',
        creditNoteId: null,
        creditNoteNumber: null,
        creditNoteDocumentUrl: null,
        receiptUrl: 'https://pay.stripe.com/receipts/ch_local_refund_123',
        paymentIntentId: 'pi_refund_webhook_123',
        invoiceId: null,
        refundStatus: 'SUCCEEDED',
        amount: payment!.amount,
        currency: payment!.currency,
        bookingId: created.bookingId,
        rawPayload: { type: 'refund.updated' },
      });

    const makeWebhookRequest = () => new Request('https://api.local/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'mock' },
      body: '{}',
    });

    await handleStripeWebhook(makeWebhookRequest(), ctx);
    const settledPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await ctx.providers.repository.updatePayment(settledPayment!.id, {
      refund_status: 'PENDING',
      refund_reason: 'Full refund initiated because cancellation happened before the lock window.',
      stripe_refund_id: 're_local_refund_123',
    });

    const response = await handleStripeWebhook(makeWebhookRequest(), ctx);
    expect(response.status).toBe(200);

    const refundedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    expect(refundedPayment?.status).toBe('REFUNDED');
    expect(refundedPayment?.refund_status).toBe('SUCCEEDED');
    expect(refundedPayment?.stripe_refund_id).toBe('re_local_refund_123');
    expect(refundedPayment?.stripe_receipt_url).toBe('https://pay.stripe.com/receipts/ch_local_refund_123');
    expect(mockState.bookingEvents.some(
      (event) => event.booking_id === created.bookingId && event.event_type === 'REFUND_COMPLETED',
    )).toBe(true);
    const refundEmail = mockState.sentEmails.find(
      (email) => email.kind === 'refund_confirmation' && email.to === 'webhook-refund@example.com',
    );
    expect(refundEmail?.subject).toContain('Your refund for');
    expect(refundEmail?.text).toContain('Your refund has been processed.');
    expect(refundEmail?.text).toContain('Amount: CHF 150.00');
    expect(refundEmail?.text).toContain('Receipt: https://pay.stripe.com/receipts/ch_local_refund_123');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'stripe_webhook_request_completed',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'refund_state_reconciled_via_shared_path',
      }),
    }));

    const repeatResponse = await handleStripeWebhook(makeWebhookRequest(), ctx);
    expect(repeatResponse.status).toBe(200);
    expect(
      mockState.bookingEvents.filter(
        (event) => event.booking_id === created.bookingId && event.event_type === 'REFUND_COMPLETED',
      ),
    ).toHaveLength(1);
    expect(
      mockState.sentEmails.filter(
        (email) => email.kind === 'refund_confirmation' && email.to === 'webhook-refund@example.com',
      ),
    ).toHaveLength(1);
  });

  it('does not send a second refund email when a later webhook confirms an already-immediate refund success', async () => {
    const ctx = makeCtx();
    const created = await createPayLaterBooking({
      slotStart: '2026-04-04T10:00:00.000Z',
      slotEnd: '2026-04-04T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Webhook Immediate Refund',
      clientEmail: 'webhook-immediate-refund@example.com',
      clientPhone: '+41000000083',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    await confirmBookingEmail(getConfirmToken(created.bookingId), ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await confirmBookingPayment({
      id: payment!.id,
      booking_id: payment!.booking_id,
      stripe_checkout_session_id: payment!.stripe_checkout_session_id,
      stripe_payment_intent_id: payment!.stripe_payment_intent_id,
      stripe_invoice_id: payment!.stripe_invoice_id,
      status: payment!.status,
    }, {
      paymentIntentId: 'pi_immediate_refund_123',
      invoiceId: payment!.stripe_invoice_id,
      invoiceUrl: payment!.invoice_url,
    }, ctx);

    const confirmedBooking = await ctx.providers.repository.getBookingById(created.bookingId);
    const canceled = await cancelBooking(confirmedBooking!, ctx);
    expect(canceled.code).toBe('CANCELED_AND_REFUNDED');
    expect(
      mockState.sentEmails.filter(
        (email) => email.kind === 'refund_confirmation' && email.to === 'webhook-immediate-refund@example.com',
      ),
    ).toHaveLength(1);

    const refundedPayment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    ctx.providers.payments.parseWebhookEvent = vi.fn().mockResolvedValue({
      eventCategory: 'refund',
      eventType: 'refund.updated',
      refundId: refundedPayment!.stripe_refund_id,
      creditNoteId: refundedPayment!.stripe_credit_note_id,
      creditNoteNumber: 'CN-2026-0004',
      creditNoteDocumentUrl: 'https://stripe.example/cn_immediate_refund_123.pdf',
      receiptUrl: 'https://pay.stripe.com/receipts/ch_immediate_refund_123',
      paymentIntentId: 'pi_immediate_refund_123',
      invoiceId: refundedPayment!.stripe_invoice_id,
      refundStatus: 'SUCCEEDED',
      amount: refundedPayment!.refund_amount,
      currency: refundedPayment!.refund_currency,
      bookingId: created.bookingId,
      rawPayload: { type: 'refund.updated' },
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
    expect(
      mockState.bookingEvents.filter(
        (event) => event.booking_id === created.bookingId && event.event_type === 'REFUND_COMPLETED',
      ),
    ).toHaveLength(1);
    expect(
      mockState.sentEmails.filter(
        (email) => email.kind === 'refund_confirmation' && email.to === 'webhook-immediate-refund@example.com',
      ),
    ).toHaveLength(1);
  });

  it('reconciles credit note references without treating credit_note.created as a cash refund outcome', async () => {
    const ctx = makeCtx();
    const created = await createPayLaterBooking({
      slotStart: '2026-04-02T10:00:00.000Z',
      slotEnd: '2026-04-02T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Webhook Credit Note',
      clientEmail: 'webhook-credit-note@example.com',
      clientPhone: '+41000000081',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    await confirmBookingEmail(getConfirmToken(created.bookingId), ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await ctx.providers.repository.updatePayment(payment!.id, {
      status: 'SUCCEEDED',
      refund_status: 'PENDING',
      refund_reason: 'Full refund initiated because cancellation happened before the lock window.',
      stripe_invoice_id: payment!.stripe_invoice_id,
    });

    ctx.providers.payments.parseWebhookEvent = vi.fn().mockResolvedValue({
      eventCategory: 'refund',
      eventType: 'credit_note.created',
      refundId: null,
      creditNoteId: 'cn_pending_credit_note_123',
      creditNoteNumber: 'CN-2026-0002',
      creditNoteDocumentUrl: 'https://stripe.example/cn_pending_credit_note_123.pdf',
      receiptUrl: null,
      paymentIntentId: null,
      invoiceId: payment!.stripe_invoice_id,
      refundStatus: null,
      amount: payment!.amount,
      currency: payment!.currency,
      bookingId: created.bookingId,
      rawPayload: { type: 'credit_note.created' },
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
    expect(refreshedPayment?.refund_status).toBe('PENDING');
    expect(refreshedPayment?.status).toBe('SUCCEEDED');
    expect(refreshedPayment?.stripe_credit_note_id).toBe('cn_pending_credit_note_123');
    expect(refreshedPayment?.stripe_credit_note_url).toBe('https://stripe.example/cn_pending_credit_note_123.pdf');
    expect(
      mockState.bookingEvents.some(
        (event) => event.booking_id === created.bookingId && event.event_type === 'REFUND_COMPLETED',
      ),
    ).toBe(false);
    expect(
      mockState.sentEmails.some(
        (email) => email.kind === 'refund_confirmation' && email.to === 'webhook-credit-note@example.com',
      ),
    ).toBe(false);
  });

  it('does not let credit_note.voided override an already succeeded refund outcome', async () => {
    const ctx = makeCtx();
    const created = await createPayLaterBooking({
      slotStart: '2026-04-03T10:00:00.000Z',
      slotEnd: '2026-04-03T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Webhook Credit Note Voided',
      clientEmail: 'webhook-credit-note-voided@example.com',
      clientPhone: '+41000000082',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    await confirmBookingEmail(getConfirmToken(created.bookingId), ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await ctx.providers.repository.updatePayment(payment!.id, {
      status: 'REFUNDED',
      refund_status: 'SUCCEEDED',
      refund_amount: payment!.amount,
      refund_currency: payment!.currency,
      stripe_invoice_id: payment!.stripe_invoice_id,
      stripe_credit_note_id: 'cn_succeeded_123',
      refunded_at: '2026-03-21T22:15:28.000Z',
    });

    ctx.providers.payments.parseWebhookEvent = vi.fn().mockResolvedValue({
      eventCategory: 'refund',
      eventType: 'credit_note.voided',
      refundId: null,
      creditNoteId: 'cn_succeeded_123',
      creditNoteNumber: 'CN-2026-0003',
      creditNoteDocumentUrl: 'https://stripe.example/cn_succeeded_123.pdf',
      receiptUrl: null,
      paymentIntentId: null,
      invoiceId: payment!.stripe_invoice_id,
      refundStatus: 'CANCELED',
      amount: payment!.amount,
      currency: payment!.currency,
      bookingId: created.bookingId,
      rawPayload: { type: 'credit_note.voided' },
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
    expect(refreshedPayment?.refund_status).toBe('SUCCEEDED');
    expect(refreshedPayment?.status).toBe('REFUNDED');
    expect(refreshedPayment?.stripe_credit_note_id).toBe('cn_succeeded_123');
    expect(refreshedPayment?.stripe_credit_note_url).toBe('https://stripe.example/cn_succeeded_123.pdf');
  });

  it('settles pay-later bookings via checkout reconciliation and sends the paid confirmation email', async () => {
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
    const paymentBeforeContinue = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await ctx.providers.repository.updatePayment(paymentBeforeContinue!.id, {
      checkout_url: 'https://example.com/dev-pay?session_id=mock_cs_pay_later_123',
      stripe_checkout_session_id: 'mock_cs_pay_later_123',
      stripe_customer_id: 'cus_pay_later_123',
    });
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    ctx.providers.payments.parseWebhookEvent = vi.fn().mockResolvedValue({
      eventCategory: 'payment',
      eventType: 'checkout.session.completed',
      checkoutSessionId: payment!.stripe_checkout_session_id,
      paymentIntentId: 'pi_checkout_pay_later_123',
      invoiceId: null,
      invoiceUrl: null,
      paymentLinkId: null,
      receiptUrl: null,
      amount: payment!.amount,
      currency: payment!.currency,
      bookingId: created.bookingId,
      customerId: payment!.stripe_customer_id,
      siteUrl: null,
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
    const paidConfirmationEmail = mockState.sentEmails
      .filter((email) => email.kind === 'booking_confirmation' && email.to === 'webhook-pay-later@example.com')
      .at(-1);
    expect(refreshedPayment?.status).toBe('SUCCEEDED');
    expect(refreshedPayment?.stripe_payment_intent_id).toBe('pi_checkout_pay_later_123');
    expect(refreshedPayment?.invoice_url).toBe('https://example.com/mock-invoice/mock_inv_pi_checkout_pay_later_123.pdf');
    expect(refreshedPayment?.stripe_receipt_url).toBe('https://example.com/mock-receipt/mock_ch_pi_checkout_pay_later_123.html');
    expect(refreshedBooking?.current_status).toBe('CONFIRMED');
    expect(paidConfirmationEmail?.subject).toBe('Your session on Mar 22 is confirmed and paid');
    expect(paidConfirmationEmail?.text).toContain('Invoice: https://example.com/mock-invoice/mock_inv_pi_checkout_pay_later_123.pdf');
    expect(paidConfirmationEmail?.text).toContain('Receipt: https://example.com/mock-receipt/mock_ch_pi_checkout_pay_later_123.html');
    expect(paidConfirmationEmail?.text).not.toContain('Complete payment:');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'stripe_webhook_request_completed',
      context: expect.objectContaining({
        stripe_event_type: 'checkout.session.completed',
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
      eventCategory: 'payment',
      eventType: 'payment_intent.succeeded',
      checkoutSessionId: null,
      paymentIntentId: 'pi_checkout_fallback_123',
      invoiceId: null,
      invoiceUrl: null,
      paymentLinkId: null,
      receiptUrl: 'https://pay.stripe.com/receipts/ch_checkout_fallback_123',
      amount: payment!.amount,
      currency: payment!.currency,
      bookingId: created.bookingId,
      customerId: payment!.stripe_customer_id,
      siteUrl: null,
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


  it('uses webhook metadata site URL for post-payment confirmation emails', async () => {
    const ctx = makeCtx();
    const created = await createPayNowBooking({
      slotStart: '2026-03-30T10:00:00.000Z',
      slotEnd: '2026-03-30T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Webhook Site Url',
      clientEmail: 'webhook-site-url@example.com',
      clientPhone: '+41000000075',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);
    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    ctx.providers.payments.parseWebhookEvent = vi.fn().mockResolvedValue({
      eventCategory: 'payment',
      eventType: 'checkout.session.completed',
      checkoutSessionId: payment!.stripe_checkout_session_id,
      paymentIntentId: 'pi_checkout_site_url_123',
      invoiceId: null,
      invoiceUrl: null,
      paymentLinkId: null,
      receiptUrl: 'https://pay.stripe.com/receipts/ch_checkout_site_url_123',
      amount: payment!.amount,
      currency: payment!.currency,
      bookingId: created.bookingId,
      customerId: payment!.stripe_customer_id,
      siteUrl: 'https://yairb.ch',
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
    const sentEmail = mockState.sentEmails.at(-1);
    expect(sentEmail?.kind).toBe('booking_confirmation');
    expect(sentEmail?.text).toContain('Manage booking: https://yairb.ch/manage.html?token=m1.');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'stripe_webhook_site_url_resolution_decision',
      context: expect.objectContaining({
        resolved_site_url: 'https://yairb.ch',
        branch_taken: 'use_webhook_metadata_site_url',
      }),
    }));
  });
});
