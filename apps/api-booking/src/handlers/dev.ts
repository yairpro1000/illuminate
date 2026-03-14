/**
 * Development-only endpoints. Some depend on the in-memory mock repository,
 * while others remain useful with a live database as long as the relevant
 * provider is still mocked.
 */

import type { AppContext } from '../router.js';
import { ok, badRequest, notFound } from '../lib/errors.js';
import { mockState } from '../providers/mock-state.js';
import { buildConfirmUrl, buildManageUrl, cancelBooking, confirmBookingPayment } from '../services/booking-service.js';
import type { OrganizerBookingRow } from '../types.js';

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

function normalizeTestEmailPrefix(raw: string | null): string | null {
  const value = raw?.trim().toLowerCase() ?? '';
  return value || null;
}

function normalizeCleanupLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return Math.min(value, 10);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return Math.min(parsed, 10);
      }
    }
  }
  return 10;
}

function isExampleTestEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.toLowerCase().endsWith('@example.test');
}

function isTerminalBookingStatus(status: OrganizerBookingRow['current_status']): boolean {
  return status === 'CANCELED' || status === 'EXPIRED' || status === 'COMPLETED' || status === 'NO_SHOW';
}

function toTestBookingSummary(row: OrganizerBookingRow) {
  return {
    booking_id: row.booking_id,
    source: row.event_id ? 'event' : 'session',
    status: row.current_status,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    client_id: row.client_id,
    client_first_name: row.client_first_name,
    client_last_name: row.client_last_name,
    client_email: row.client_email,
    event_id: row.event_id,
    event_title: row.event_title,
    session_type_id: row.session_type_id,
    session_type_title: row.session_type_title,
    payment_status: row.payment_status,
    latest_event_type: row.latest_event_type,
  };
}

async function findMatchingTestBookings(emailPrefix: string, ctx: AppContext): Promise<OrganizerBookingRow[]> {
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_lookup_clients_started',
    message: 'Started loading test-booking clients by email prefix',
    context: {
      email_prefix: emailPrefix,
      branch_taken: 'load_test_clients_by_email_prefix',
    },
  });
  const clients = await ctx.providers.repository.listClientsByEmailPrefix(emailPrefix);
  const matchingClients = clients.filter((client) => isExampleTestEmail(client.email));
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_lookup_clients_completed',
    message: 'Resolved test-booking clients by email prefix',
    context: {
      email_prefix: emailPrefix,
      matched_client_count: matchingClients.length,
      branch_taken: 'return_matching_test_clients',
    },
  });
  if (matchingClients.length === 0) return [];

  const rows: OrganizerBookingRow[] = [];
  for (const client of matchingClients) {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'test_bookings_lookup_client_bookings_started',
      message: 'Started loading organizer bookings for matched test client',
      context: {
        email_prefix: emailPrefix,
        client_id: client.id,
        client_email: client.email,
        branch_taken: 'load_organizer_bookings_for_test_client',
      },
    });
    const clientRows = await ctx.providers.repository.getOrganizerBookings({ client_id: client.id });
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'test_bookings_lookup_client_bookings_completed',
      message: 'Resolved organizer bookings for matched test client',
      context: {
        email_prefix: emailPrefix,
        client_id: client.id,
        client_email: client.email,
        booking_count: clientRows.length,
        branch_taken: 'return_organizer_bookings_for_test_client',
      },
    });
    rows.push(...clientRows);
  }

  return rows
    .filter((row) => {
      const email = row.client_email.toLowerCase();
      return isExampleTestEmail(email) && email.startsWith(emailPrefix);
    })
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
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
    throw err;
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
    throw err;
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
    throw err;
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
    throw err;
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

// GET /api/__test/bookings?email_prefix=<prefix>
export async function handleTestBookingsList(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const url = new URL(request.url);
  const emailPrefix = normalizeTestEmailPrefix(url.searchParams.get('email_prefix'));

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_list_request_started',
    message: 'Started test bookings list lookup',
    context: {
      path,
      has_email_prefix: Boolean(emailPrefix),
      branch_taken: 'validate_test_bookings_list_request',
    },
  });

  if (!emailPrefix) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_bookings_list_request_rejected',
      message: 'Rejected test bookings list request because email_prefix was missing',
      context: {
        path,
        branch_taken: 'deny_missing_email_prefix',
        deny_reason: 'email_prefix_missing',
      },
    });
    throw badRequest('email_prefix is required');
  }

  const matches = await findMatchingTestBookings(emailPrefix, ctx);
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_list_request_completed',
    message: 'Resolved test bookings list',
    context: {
      path,
      email_prefix: emailPrefix,
      matched_count: matches.length,
      branch_taken: 'return_test_bookings_list',
    },
  });

  return ok({
    email_prefix: emailPrefix,
    count: matches.length,
    bookings: matches.map(toTestBookingSummary),
  });
}

// POST /api/__test/bookings/cleanup
export async function handleTestBookingsCleanup(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const body = await request.json() as Record<string, unknown>;
  const emailPrefix = normalizeTestEmailPrefix(typeof body.email_prefix === 'string' ? body.email_prefix : null);
  const limit = normalizeCleanupLimit(body.limit);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_cleanup_started',
    message: 'Started test bookings cleanup request',
    context: {
      path,
      has_email_prefix: Boolean(emailPrefix),
      batch_limit: limit,
      branch_taken: 'validate_test_bookings_cleanup_request',
    },
  });

  if (!emailPrefix) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'test_bookings_cleanup_rejected',
      message: 'Rejected test bookings cleanup request because email_prefix was missing',
      context: {
        path,
        branch_taken: 'deny_missing_email_prefix',
        deny_reason: 'email_prefix_missing',
      },
    });
    throw badRequest('email_prefix is required');
  }

  const matches = await findMatchingTestBookings(emailPrefix, ctx);
  const activeMatches = matches.filter((row) => !isTerminalBookingStatus(row.current_status));
  const terminalMatches = matches.filter((row) => isTerminalBookingStatus(row.current_status));
  const batch = activeMatches.slice(0, limit);
  const canceled: Array<{ booking_id: string; status: string }> = [];
  const skipped: Array<{ booking_id: string; status: string; reason: string }> = [];
  const failed: Array<{ booking_id: string; status: string; reason: string }> = [];

  for (const row of terminalMatches) {
    skipped.push({
      booking_id: row.booking_id,
      status: row.current_status,
      reason: 'already_terminal',
    });
  }

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_cleanup_batch_planned',
    message: 'Planned test bookings cleanup batch',
    context: {
      path,
      email_prefix: emailPrefix,
      matched_count: matches.length,
      active_matched_count: activeMatches.length,
      terminal_matched_count: terminalMatches.length,
      processed_count: batch.length,
      batch_limit: limit,
      branch_taken: 'cleanup_batch_planned',
    },
  });

  for (const row of batch) {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'test_bookings_cleanup_booking_started',
      message: 'Started cleanup for test booking',
      context: {
        path,
        email_prefix: emailPrefix,
        booking_id: row.booking_id,
        booking_status: row.current_status,
        client_id: row.client_id,
        client_email: row.client_email,
        branch_taken: 'cleanup_single_booking_started',
      },
    });
    try {
      const booking = await ctx.providers.repository.getBookingById(row.booking_id);
      if (!booking) {
        failed.push({
          booking_id: row.booking_id,
          status: row.current_status,
          reason: 'booking_lookup_failed',
        });
        ctx.logger.logWarn?.({
          source: 'backend',
          eventType: 'test_bookings_cleanup_booking_failed',
          message: 'Failed test booking cleanup because booking lookup did not return a row',
          context: {
            path,
            email_prefix: emailPrefix,
            booking_id: row.booking_id,
            booking_status: row.current_status,
            branch_taken: 'cleanup_booking_lookup_failed',
            deny_reason: 'booking_lookup_failed',
          },
        });
        continue;
      }

      const result = await cancelBooking(booking, {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        operation: ctx.operation,
      }, {
        source: 'ADMIN_UI',
        bypassPolicyWindow: true,
      });

      if (!result.ok) {
        failed.push({
          booking_id: row.booking_id,
          status: row.current_status,
          reason: result.code,
        });
        ctx.logger.logWarn?.({
          source: 'backend',
          eventType: 'test_bookings_cleanup_booking_failed',
          message: 'Failed test booking cleanup because cancellation service denied the booking',
          context: {
            path,
            email_prefix: emailPrefix,
            booking_id: row.booking_id,
            booking_status: row.current_status,
            branch_taken: 'cleanup_cancellation_denied',
            deny_reason: result.code,
          },
        });
        continue;
      }

      canceled.push({
        booking_id: row.booking_id,
        status: result.booking.current_status,
      });
      ctx.logger.logInfo?.({
        source: 'backend',
        eventType: 'test_bookings_cleanup_booking_completed',
        message: 'Completed cleanup for test booking',
        context: {
          path,
          email_prefix: emailPrefix,
          booking_id: row.booking_id,
          booking_status: result.booking.current_status,
          branch_taken: 'cleanup_single_booking_canceled',
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unexpected_cleanup_failure';
      failed.push({
        booking_id: row.booking_id,
        status: row.current_status,
        reason,
      });
      ctx.logger.captureException?.({
        source: 'backend',
        eventType: 'test_bookings_cleanup_booking_failed',
        message: 'Unexpected test booking cleanup failure',
        error,
        context: {
          path,
          email_prefix: emailPrefix,
          booking_id: row.booking_id,
          booking_status: row.current_status,
          branch_taken: 'cleanup_unexpected_exception',
        },
      });
    }
  }

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'test_bookings_cleanup_completed',
    message: 'Completed test bookings cleanup request',
    context: {
      path,
      email_prefix: emailPrefix,
      matched_count: matches.length,
      active_matched_count: activeMatches.length,
      processed_count: batch.length,
      remaining_active_count: Math.max(activeMatches.length - batch.length, 0),
      batch_limit: limit,
      canceled_count: canceled.length,
      skipped_count: skipped.length,
      failed_count: failed.length,
      branch_taken: failed.length > 0 ? 'cleanup_completed_with_failures' : 'cleanup_completed_successfully',
      deny_reason: failed.length > 0 ? 'one_or_more_bookings_failed_cleanup' : null,
    },
  });

  return ok({
    email_prefix: emailPrefix,
    matched_count: matches.length,
    active_matched_count: activeMatches.length,
    processed_count: batch.length,
    remaining_active_count: Math.max(activeMatches.length - batch.length, 0),
    batch_limit: limit,
    canceled_count: canceled.length,
    skipped_count: skipped.length,
    failed_count: failed.length,
    canceled,
    skipped,
    failed,
  });
}
