/**
 * Development-only endpoints. Only active when REPOSITORY_MODE !== 'supabase'
 * (i.e. the in-memory mock repository is in use).
 * Provides: payment simulation, sent-email inspection, failure-log inspection.
 */

import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse, jsonResponse } from '../lib/errors.js';
import { mockState } from '../providers/mock-state.js';
import { confirmBookingPayment } from '../services/booking-service.js';
import { confirmRegistrationPayment } from '../services/registration-service.js';

function guardMockOnly(ctx: AppContext): void {
  if (ctx.env.REPOSITORY_MODE === 'supabase') {
    throw badRequest('Dev endpoints are not available when using real providers');
  }
}

// POST /api/__dev/simulate-payment?session_id=<id>&result=success|failure
// Called by dev-pay.html after user clicks a button.
export async function handleSimulatePayment(request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockOnly(ctx);

    const url       = new URL(request.url);
    const sessionId = url.searchParams.get('session_id');
    const result    = url.searchParams.get('result'); // 'success' | 'failure'

    if (!sessionId || !result) throw badRequest('session_id and result are required');

    const payment = await ctx.providers.repository.getPaymentByStripeSessionId(sessionId);
    if (!payment) throw badRequest('Payment not found for session_id');
    if (payment.status === 'succeeded') return ok({ ok: true, already: 'succeeded' });

    if (result === 'failure') {
      await ctx.providers.repository.updatePayment(payment.id, { status: 'failed' });
      return ok({ ok: true, status: 'failed' });
    }

    if (result !== 'success') throw badRequest('result must be success or failure');

    const stripeData = {
      paymentIntentId: `mock_pi_${crypto.randomUUID()}`,
      invoiceId:       `mock_inv_${crypto.randomUUID()}`,
      invoiceUrl:      `${ctx.env.SITE_URL}/mock-invoice/${sessionId}.pdf`,
    };

    const svcCtx = { providers: ctx.providers, env: ctx.env, logger: ctx.logger, requestId: ctx.requestId };

    if (payment.kind === 'booking') {
      await confirmBookingPayment(payment, stripeData, svcCtx);
    } else {
      await confirmRegistrationPayment(payment, stripeData, svcCtx);
    }

    return ok({ ok: true, status: 'succeeded' });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/__dev/emails — inspect sent emails (most recent first)
export async function handleDevEmails(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockOnly(ctx);
    const emails = mockState.sentEmails.slice(-50).reverse();
    return ok({ emails });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/__dev/failures — inspect recent failure logs
export async function handleDevFailures(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockOnly(ctx);
    const logs = await ctx.providers.repository.getRecentFailureLogs(50);
    return ok({ failure_logs: logs });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/__dev/bookings — inspect all in-memory bookings
export async function handleDevBookings(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    guardMockOnly(ctx);
    const bookings = [...mockState.bookings.values()];
    const payments = [...mockState.payments.values()];
    return ok({ bookings, payments });
  } catch (err) {
    return errorResponse(err);
  }
}
