import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/router.js';
import { confirmBookingEmail, createPayLaterBooking } from '../src/services/booking-service.js';
import { makeCtx } from './admin-helpers.js';

describe('Continue payment public guard', () => {
  it('returns checkout action only when booking and payment are both pending', async () => {
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

    const submission = (await ctx.providers.repository.listBookingEvents(created.bookingId))
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    await confirmBookingEmail(String(submission?.payload?.['confirm_token'] ?? ''), ctx);

    const res = await handleRequest(
      new Request(`https://api.local/api/bookings/continue-payment?token=m1.${created.bookingId}`, { method: 'GET' }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_id: created.bookingId,
      status: 'PENDING',
      payment_status: 'PENDING',
      action: 'checkout',
      action_url: expect.stringContaining('/dev-pay?session_id='),
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

  it('returns manage action and explicit diagnostic reason when payment is no longer pending', async () => {
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

    const submission = (await ctx.providers.repository.listBookingEvents(created.bookingId))
      .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');
    await confirmBookingEmail(String(submission?.payload?.['confirm_token'] ?? ''), ctx);

    const payment = await ctx.providers.repository.getPaymentByBookingId(created.bookingId);
    await ctx.providers.repository.updatePayment(payment!.id, { status: 'SUCCEEDED' });

    const res = await handleRequest(
      new Request(`https://api.local/api/bookings/continue-payment?token=m1.${created.bookingId}`, { method: 'GET' }),
      ctx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(expect.objectContaining({
      booking_id: created.bookingId,
      payment_status: 'SUCCEEDED',
      action: 'manage',
      action_url: `https://example.com/manage.html?token=m1.${created.bookingId}`,
      checkout_url: null,
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'continue_payment_request_decision',
      context: expect.objectContaining({
        booking_id: created.bookingId,
        branch_taken: 'deny_continue_payment_payment_not_pending',
        deny_reason: 'payment_not_pending',
      }),
    }));
  });
});

function makeBookingCtx() {
  let checkoutCounter = 0;
  return makeCtx({
    providers: {
      antibot: {
        verify: vi.fn().mockResolvedValue(undefined),
      },
      calendar: {
        getBusyTimes: vi.fn().mockResolvedValue([]),
      },
      payments: {
        createCheckoutSession: vi.fn().mockImplementation(async ({ bookingId }) => {
          checkoutCounter += 1;
          return {
            sessionId: `mock_cs_${checkoutCounter}`,
            checkoutUrl: `https://example.com/dev-pay?session_id=mock_cs_${checkoutCounter}&booking_id=${bookingId}`,
            amountCents: 15000,
            currency: 'CHF',
          };
        }),
      },
      email: {
        sendBookingConfirmRequest: vi.fn().mockResolvedValue({ messageId: 'msg-confirm' }),
        sendBookingPaymentDue: vi.fn().mockResolvedValue({ messageId: 'msg-pay-due' }),
      },
    } as any,
  });
}
