import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/router.js';
import { confirmBookingEmail, createPayLaterBooking } from '../src/services/booking-service.js';
import { mockState } from '../src/providers/mock-state.js';
import { makeCtx } from './admin-helpers.js';

describe('Continue payment public guard', () => {
  it('returns checkout action only after pay-later booking confirmation', async () => {
    const ctx = makeBookingCtx();

    const created = await createPayLaterBooking({
      slotStart: '2026-03-19T10:00:00.000Z',
      slotEnd: '2026-03-19T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Guarded Pay',
      clientEmail: 'guarded@example.com',
      clientPhone: '+41000000021',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const token = getConfirmToken(created.bookingId);
    await confirmBookingEmail(token, ctx);

    const res = await handleRequest(
      new Request(`https://api.local/api/bookings/continue-payment?token=m1.${created.bookingId}`, { method: 'GET' }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_id: created.bookingId,
      status: 'CONFIRMED',
      payment_status: 'INVOICE_SENT',
      action: 'checkout',
      action_url: expect.stringContaining('/mock-invoice/'),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'continue_payment_request_decision',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'allow_continue_payment_redirect',
        deny_reason: null,
      }),
    }));
  });

  it('still returns checkout action when payment previously failed but booking remains confirmed', async () => {
    const ctx = makeBookingCtx();

    const created = await createPayLaterBooking({
      slotStart: '2026-03-20T10:00:00.000Z',
      slotEnd: '2026-03-20T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Settled Pay',
      clientEmail: 'settled@example.com',
      clientPhone: '+41000000022',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const token = getConfirmToken(created.bookingId);
    await confirmBookingEmail(token, ctx);

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await ctx.providers.repository.updatePayment(payment!.id, { status: 'FAILED' });

    const res = await handleRequest(
      new Request(`https://api.local/api/bookings/continue-payment?token=m1.${created.bookingId}`, { method: 'GET' }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_id: created.bookingId,
      payment_status: 'FAILED',
      action: 'checkout',
      action_url: expect.stringContaining('/mock-invoice/'),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'continue_payment_request_decision',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'allow_continue_payment_redirect',
        deny_reason: null,
      }),
    }));
  });

  it('still allows online continuation once manual payment arrangement is approved', async () => {
    const ctx = makeBookingCtx();

    const created = await createPayLaterBooking({
      slotStart: '2026-03-21T10:00:00.000Z',
      slotEnd: '2026-03-21T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Manual Arrangement',
      clientEmail: 'cashok@example.com',
      clientPhone: '+41000000023',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const token = getConfirmToken(created.bookingId);
    await confirmBookingEmail(token, ctx);

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await ctx.providers.repository.updatePayment(payment!.id, { status: 'CASH_OK' });

    const res = await handleRequest(
      new Request(`https://api.local/api/bookings/continue-payment?token=m1.${created.bookingId}`, { method: 'GET' }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_id: created.bookingId,
      payment_status: 'CASH_OK',
      action: 'checkout',
      action_url: expect.stringContaining('/mock-invoice/'),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'continue_payment_request_decision',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'allow_continue_payment_redirect',
        deny_reason: null,
      }),
    }));
  });

  it('bootstraps a checkout session when confirmation created a payment row but no invoice URL', async () => {
    const ctx = makeBookingCtx();
    ctx.providers.payments.createInvoice = vi.fn().mockRejectedValue(new Error('stripe_invoice_failed'));

    const created = await createPayLaterBooking({
      slotStart: '2026-03-22T10:00:00.000Z',
      slotEnd: '2026-03-22T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      sessionType: 'session',
      clientName: 'Fallback Checkout',
      clientEmail: 'fallback-checkout@example.com',
      clientPhone: '+41000000024',
      reminderEmailOptIn: true,
      reminderWhatsappOptIn: false,
      turnstileToken: 'ok',
      remoteIp: null,
    }, ctx);

    const token = getConfirmToken(created.bookingId);
    await confirmBookingEmail(token, ctx);

    const res = await handleRequest(
      new Request(`https://api.local/api/bookings/continue-payment?token=m1.${created.bookingId}`, { method: 'GET' }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_id: created.bookingId,
      status: 'CONFIRMED',
      payment_status: 'PENDING',
      action: 'checkout',
      action_url: expect.stringContaining('/dev-pay?session_id=mock_cs_'),
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'continue_payment_request_decision',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'allow_continue_payment_redirect_after_bootstrap',
        deny_reason: null,
      }),
    }));
  });
});

function getConfirmToken(bookingId: string): string {
  const submission = mockState.bookingEvents
    .filter((event) => event.booking_id === bookingId)
    .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
  return String(submission?.payload?.confirm_token ?? '');
}

function makeBookingCtx() {
  let checkoutCounter = 0;
  return makeCtx({
    providers: {
      antibot: {
        verify: vi.fn().mockResolvedValue(undefined),
      },
      calendar: {
        getBusyTimes: vi.fn().mockResolvedValue([]),
        createEvent: vi.fn().mockResolvedValue({
          eventId: 'g-confirmed',
          meetingProvider: 'google_meet',
          meetingLink: 'https://meet.google.com/test-confirmed',
        }),
        updateEvent: vi.fn().mockResolvedValue(undefined),
        deleteEvent: vi.fn().mockResolvedValue(undefined),
      },
      payments: {
        createCheckoutSession: vi.fn().mockImplementation(async ({ bookingId }) => {
          checkoutCounter += 1;
          return {
            sessionId: `mock_cs_${checkoutCounter}`,
            checkoutUrl: `https://example.com/dev-pay?session_id=mock_cs_${checkoutCounter}&booking_id=${bookingId}`,
            amount: 150,
            currency: 'CHF',
          };
        }),
        createInvoice: vi.fn().mockImplementation(async ({ bookingId, amount, currency, customerEmail }) => {
          checkoutCounter += 1;
          return {
            invoiceId: `mock_in_${checkoutCounter}`,
            invoiceUrl: `https://example.com/mock-invoice/mock_in_${checkoutCounter}?booking_id=${bookingId}&amount=${amount}&currency=${currency}&email=${encodeURIComponent(customerEmail)}`,
            amount,
            currency,
          };
        }),
      },
      email: {
        sendBookingConfirmRequest: vi.fn().mockResolvedValue({ messageId: 'msg-confirm' }),
        sendBookingConfirmation: vi.fn().mockResolvedValue({ messageId: 'msg-booking-confirmed' }),
        sendBookingPaymentDue: vi.fn().mockResolvedValue({ messageId: 'msg-pay-due' }),
      },
    } as any,
  });
}
