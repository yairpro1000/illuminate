/**
 * Development-only endpoints. Some depend on the in-memory mock repository,
 * while others remain useful with a live database as long as the relevant
 * provider is still mocked.
 */

import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse, notFound } from '../lib/errors.js';
import { mockState } from '../providers/mock-state.js';
import { buildConfirmUrl, buildManageUrl, confirmBookingPayment } from '../services/booking-service.js';

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

function normalizeExampleTestEmail(raw: string | null): string | null {
  const value = raw?.trim().toLowerCase() ?? '';
  return value || null;
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

// GET /api/__test/booking-artifacts?email=<fake@example.test>
export async function handleTestBookingArtifacts(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const url = new URL(request.url);
  const email = normalizeExampleTestEmail(url.searchParams.get('email'));

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_booking_artifacts_request_started',
    message: 'Started test booking-artifacts lookup',
    context: {
      path,
      has_email: Boolean(email),
      branch_taken: 'validate_test_booking_artifacts_request',
    },
  });

  if (!email) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_booking_artifacts_request_rejected',
      message: 'Rejected test booking-artifacts request because email was missing',
      context: {
        path,
        branch_taken: 'deny_missing_email',
        deny_reason: 'email_missing',
      },
    });
    throw badRequest('email is required');
  }

  if (!email.endsWith('@example.test')) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_booking_artifacts_request_rejected',
      message: 'Rejected test booking-artifacts request because email was not a fake test domain',
      context: {
        path,
        email_domain: email.split('@')[1] ?? null,
        branch_taken: 'deny_non_test_email_domain',
        deny_reason: 'email_must_use_example_test_domain',
      },
    });
    throw badRequest('email must use @example.test');
  }

  const client = await ctx.providers.repository.getClientByEmail(email);
  if (!client) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_booking_artifacts_request_rejected',
      message: 'Rejected test booking-artifacts request because client was not found',
      context: {
        path,
        email,
        branch_taken: 'deny_client_not_found',
        deny_reason: 'test_client_not_found',
      },
    });
    throw notFound('Test client not found');
  }

  const rows = await ctx.providers.repository.getOrganizerBookings({ client_id: client.id });
  const latest = rows
    .slice()
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];

  if (!latest) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_booking_artifacts_request_rejected',
      message: 'Rejected test booking-artifacts request because no bookings were found for the client',
      context: {
        path,
        email,
        client_id: client.id,
        branch_taken: 'deny_booking_not_found',
        deny_reason: 'test_booking_not_found',
      },
    });
    throw notFound('Test booking not found');
  }

  const booking = await ctx.providers.repository.getBookingById(latest.booking_id);
  if (!booking) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_booking_artifacts_request_rejected',
      message: 'Rejected test booking-artifacts request because booking details could not be loaded',
      context: {
        path,
        email,
        client_id: client.id,
        booking_id: latest.booking_id,
        branch_taken: 'deny_booking_lookup_failed',
        deny_reason: 'test_booking_lookup_failed',
      },
    });
    throw notFound('Test booking not found');
  }

  const events = await ctx.providers.repository.listBookingEvents(booking.id);
  const latestSubmitted = events
    .filter((event) => event.event_type === 'BOOKING_FORM_SUBMITTED')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  const confirmToken = typeof latestSubmitted?.payload?.['confirm_token'] === 'string'
    ? latestSubmitted.payload['confirm_token'] as string
    : null;
  const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const manageUrl = await buildManageUrl(ctx.env.SITE_URL, booking);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_booking_artifacts_request_completed',
    message: 'Resolved test booking artifacts',
    context: {
      path,
      email,
      client_id: client.id,
      booking_id: booking.id,
      booking_source: booking.event_id ? 'event' : 'session',
      has_confirm_token: Boolean(confirmToken),
      has_payment: Boolean(payment),
      branch_taken: 'return_test_booking_artifacts',
    },
  });

  return ok({
    client: {
      id: client.id,
      email: client.email,
    },
    booking: {
      id: booking.id,
      source: booking.event_id ? 'event' : 'session',
      status: booking.current_status,
      event_id: booking.event_id,
      session_type_id: booking.session_type_id,
      starts_at: booking.starts_at,
      ends_at: booking.ends_at,
      timezone: booking.timezone,
    },
    links: {
      confirm_url: confirmToken ? buildConfirmUrl(ctx.env.SITE_URL, confirmToken) : null,
      manage_url: manageUrl,
    },
    payment: payment ? {
      id: payment.id,
      status: payment.status,
      session_id: payment.provider_payment_id,
      checkout_url: payment.checkout_url,
    } : null,
  });
}
