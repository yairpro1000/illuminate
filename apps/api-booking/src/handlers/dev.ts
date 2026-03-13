/**
 * Development-only endpoints. Some depend on the in-memory mock repository,
 * while others remain useful with a live database as long as the relevant
 * provider is still mocked.
 */

import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { mockState } from '../providers/mock-state.js';
import { confirmBookingPayment } from '../services/booking-service.js';

function guardMockRepository(ctx: AppContext): void {
  if (ctx.env.REPOSITORY_MODE === 'supabase') {
    throw badRequest('This dev endpoint is only available with the in-memory mock repository');
  }
}

function guardMockPayments(ctx: AppContext): void {
  if (ctx.env.PAYMENTS_MODE !== 'mock') {
    throw badRequest('This dev endpoint is only available when payments are mocked');
  }
}

function guardMockEmail(ctx: AppContext): void {
  if (ctx.env.EMAIL_MODE !== 'mock') {
    throw badRequest('This dev endpoint is only available when email is mocked');
  }
}

// POST /api/__dev/simulate-payment?session_id=<id>&result=success|failure
export async function handleSimulatePayment(request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockPayments(ctx);

    const url = new URL(request.url);
    const sessionId = url.searchParams.get('session_id');
    const result = url.searchParams.get('result');

    if (!sessionId || !result) throw badRequest('session_id and result are required');

    const payment = await ctx.providers.repository.getPaymentByStripeSessionId(sessionId);
    if (!payment) throw badRequest('Payment not found for session_id');
    if (payment.status === 'SUCCEEDED') return ok({ already: 'succeeded' });

    if (result === 'failure') {
      await ctx.providers.repository.updatePayment(payment.id, { status: 'FAILED' });
      return ok({ status: 'failed' });
    }

    if (result !== 'success') throw badRequest('result must be success or failure');

    await confirmBookingPayment(
      {
        id: payment.id,
        booking_id: payment.booking_id,
        provider_payment_id: payment.provider_payment_id,
      },
      {
        paymentIntentId: `mock_pi_${crypto.randomUUID()}`,
        invoiceId: `mock_inv_${crypto.randomUUID()}`,
        invoiceUrl: `${ctx.env.SITE_URL}/mock-invoice/${sessionId}.pdf`,
      },
      {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
      },
    );

    return ok({ status: 'succeeded' });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/__dev/emails
export async function handleDevEmails(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockEmail(ctx);
    const emails = mockState.sentEmails.slice(-50).reverse().map((email) => ({
      to: email.to,
      subject: email.subject,
      kind: email.kind,
      sentAt: email.sentAt,
    }));
    return ok({ emails });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/__dev/failures
export async function handleDevFailures(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockRepository(ctx);
    const failedAttempts = mockState.sideEffectAttempts
      .filter((attempt) => attempt.status === 'FAILED')
      .slice(-50)
      .reverse()
      .map((attempt) => {
        const effect = mockState.sideEffects.find((row) => row.id === attempt.booking_side_effect_id);
        return {
          id: attempt.id,
          booking_side_effect_id: attempt.booking_side_effect_id,
          booking_id: effect?.booking_id ?? null,
          effect_intent: effect?.effect_intent ?? null,
          attempt_num: attempt.attempt_num,
          error_message: attempt.error_message,
          created_at: attempt.created_at,
        };
      });
    return ok({ failed_side_effect_attempts: failedAttempts });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/__dev/bookings
export async function handleDevBookings(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockRepository(ctx);
    const bookings = [...mockState.bookings.values()].map((booking) => ({
      id: booking.id,
      client_id: booking.client_id,
      source: booking.event_id ? 'event' : 'session',
      status: booking.current_status,
      event_id: booking.event_id,
      session_type_id: booking.session_type_id,
      starts_at: booking.starts_at,
      ends_at: booking.ends_at,
      timezone: booking.timezone,
      google_event_id: booking.google_event_id,
      created_at: booking.created_at,
      updated_at: booking.updated_at,
    }));
    const clients = [...mockState.clients.values()];
    const payments = [...mockState.payments.values()].map((payment) => ({
      id: payment.id,
      booking_id: payment.booking_id,
      provider: payment.provider,
      provider_payment_id: payment.provider_payment_id,
      amount_cents: payment.amount_cents,
      currency: payment.currency,
      status: payment.status,
      invoice_url: payment.invoice_url,
      paid_at: payment.paid_at,
      created_at: payment.created_at,
      updated_at: payment.updated_at,
    }));
    return ok({ bookings, clients, payments });
  } catch (err) {
    return errorResponse(err);
  }
}
