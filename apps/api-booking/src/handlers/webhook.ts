import type { AppContext } from '../router.js';
import { ok } from '../lib/errors.js';
import type { StripePaymentEvent } from '../providers/payments/interface.js';
import { resolveStripeRuntimeConfig } from '../providers/payments/runtime-config.js';
import type { Payment } from '../types.js';
import { confirmBookingPayment } from '../services/booking-service.js';

// POST /api/stripe/webhook
export async function handleStripeWebhook(request: Request, ctx: AppContext): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature') ?? '';

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'stripe_webhook_request_started',
    message: 'Started Stripe webhook handling',
    context: {
      path: new URL(request.url).pathname,
      has_signature: Boolean(signature),
      branch_taken: 'parse_and_reconcile_webhook_event',
    },
  });

  const stripeRuntimeConfig = resolveStripeRuntimeConfig(ctx.env, ctx.env.PAYMENTS_MODE);
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'stripe_webhook_secret_selection_decision',
    message: 'Evaluated Stripe webhook secret selection',
    context: {
      payments_mode_effective: ctx.env.PAYMENTS_MODE ?? null,
      stripe_runtime_mode: stripeRuntimeConfig?.mode ?? null,
      stripe_webhook_secret_present: Boolean(stripeRuntimeConfig?.webhookSecret),
      branch_taken: stripeRuntimeConfig
        ? 'use_selected_stripe_runtime_webhook_secret'
        : 'use_empty_webhook_secret_for_mock_mode',
      deny_reason: stripeRuntimeConfig ? null : 'payments_mode_is_mock',
    },
  });

  const event = await ctx.providers.payments.parseWebhookEvent(
    rawBody,
    signature,
    stripeRuntimeConfig?.webhookSecret ?? '',
  );

  if (!event) {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'stripe_webhook_request_completed',
      message: 'Ignored Stripe webhook event because it is not handled',
      context: {
        branch_taken: 'ignore_unhandled_webhook_event',
        deny_reason: 'event_type_not_supported',
      },
    });
    return ok({ received: true, handled: false });
  }

  const paymentMatch = await findPaymentForStripeEvent(event, ctx);
  const payment = paymentMatch.payment;
  if (!payment) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'stripe_webhook_request_completed',
      message: 'Stripe webhook event could not be reconciled to a payment row',
      context: {
        stripe_event_type: event.eventType,
        stripe_checkout_session_id: event.checkoutSessionId,
        stripe_payment_intent_id: event.paymentIntentId,
        stripe_invoice_id: event.invoiceId,
        booking_id: event.bookingId,
        attempted_match_branches: paymentMatch.attemptedBranches,
        branch_taken: paymentMatch.branchTaken,
        deny_reason: paymentMatch.denyReason,
      },
    });
    return ok({ received: true, handled: false });
  }

  if (payment.status === 'SUCCEEDED') {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'stripe_webhook_request_completed',
      message: 'Stripe webhook event was idempotent because payment is already settled',
      context: {
        payment_id: payment.id,
        booking_id: payment.booking_id,
        stripe_event_type: event.eventType,
        matched_branch: paymentMatch.branchTaken,
        branch_taken: 'idempotent_already_succeeded',
        deny_reason: null,
      },
    });
    return ok({ received: true, handled: true, idempotent: true });
  }

  const settledSiteUrl = event.siteUrl ?? ctx.siteUrl;
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'stripe_webhook_site_url_resolution_decision',
    message: 'Resolved public site URL for Stripe webhook settlement side effects',
    context: {
      payment_id: payment.id,
      booking_id: payment.booking_id,
      stripe_event_type: event.eventType,
      webhook_event_site_url: event.siteUrl,
      request_site_url: ctx.siteUrl,
      resolved_site_url: settledSiteUrl,
      branch_taken: event.siteUrl
        ? 'use_webhook_metadata_site_url'
        : 'fallback_request_site_url',
      deny_reason: event.siteUrl ? null : 'webhook_metadata_site_url_missing',
    },
  });

  await confirmBookingPayment(
    {
      id: payment.id,
      booking_id: payment.booking_id,
      status: payment.status,
      stripe_checkout_session_id: payment.stripe_checkout_session_id,
      stripe_payment_intent_id: payment.stripe_payment_intent_id,
      stripe_invoice_id: payment.stripe_invoice_id,
    },
    {
      paymentIntentId: event.paymentIntentId,
      invoiceId: event.invoiceId,
      invoiceUrl: event.invoiceUrl,
      rawPayload: event.rawPayload,
    },
    {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      operation: ctx.operation,
      siteUrl: settledSiteUrl,
    },
  );

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'stripe_webhook_request_completed',
    message: 'Stripe webhook event settled the payment through the shared booking path',
    context: {
      payment_id: payment.id,
      booking_id: payment.booking_id,
      stripe_event_type: event.eventType,
      stripe_checkout_session_id: event.checkoutSessionId,
      stripe_payment_intent_id: event.paymentIntentId,
      stripe_invoice_id: event.invoiceId,
      matched_branch: paymentMatch.branchTaken,
      branch_taken: 'payment_settled_via_shared_path',
      deny_reason: null,
    },
  });

  return ok({ received: true, handled: true });
}

interface StripeWebhookPaymentMatchResult {
  payment: Payment | null;
  branchTaken: string;
  attemptedBranches: string[];
  denyReason: string | null;
}

async function findPaymentForStripeEvent(
  event: StripePaymentEvent,
  ctx: AppContext,
): Promise<StripeWebhookPaymentMatchResult> {
  const attempts = buildStripeWebhookPaymentLookupPlan(event, ctx);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'stripe_webhook_payment_lookup_started',
    message: 'Started Stripe webhook payment reconciliation',
    context: {
      stripe_event_type: event.eventType,
      stripe_checkout_session_id: event.checkoutSessionId,
      stripe_payment_intent_id: event.paymentIntentId,
      stripe_invoice_id: event.invoiceId,
      booking_id: event.bookingId,
      attempted_match_branches: attempts.map((attempt) => attempt.branch),
      branch_taken: 'evaluate_reconciliation_lookup_plan',
      deny_reason: null,
    },
  });

  for (const attempt of attempts) {
    const payment = await attempt.lookup();
    if (!payment) continue;

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'stripe_webhook_payment_lookup_completed',
      message: 'Matched Stripe webhook event to payment row',
      context: {
        stripe_event_type: event.eventType,
        payment_id: payment.id,
        booking_id: payment.booking_id,
        matched_identifier_kind: attempt.identifierKind,
        matched_identifier_value: attempt.identifierValue,
        attempted_match_branches: attempts.map((candidate) => candidate.branch),
        branch_taken: attempt.branch,
        deny_reason: null,
      },
    });

    return {
      payment,
      branchTaken: attempt.branch,
      attemptedBranches: attempts.map((candidate) => candidate.branch),
      denyReason: null,
    };
  }

  return {
    payment: null,
    branchTaken: attempts.length > 0
      ? 'deny_missing_payment_match_after_lookup_plan'
      : 'deny_missing_reconciliation_identifiers',
    attemptedBranches: attempts.map((attempt) => attempt.branch),
    denyReason: attempts.length > 0
      ? 'payment_not_found_for_webhook_identifiers'
      : 'webhook_event_missing_reconciliation_identifiers',
  };
}

interface StripeWebhookLookupAttempt {
  branch: string;
  identifierKind: 'checkout_session_id' | 'payment_intent_id' | 'invoice_id' | 'booking_id';
  identifierValue: string;
  lookup: () => Promise<Payment | null>;
}

function buildStripeWebhookPaymentLookupPlan(
  event: StripePaymentEvent,
  ctx: AppContext,
): StripeWebhookLookupAttempt[] {
  const attempts: StripeWebhookLookupAttempt[] = [];
  const pushAttempt = (
    branch: StripeWebhookLookupAttempt['branch'],
    identifierKind: StripeWebhookLookupAttempt['identifierKind'],
    identifierValue: string | null,
    lookup: () => Promise<Payment | null>,
  ): void => {
    if (!identifierValue) return;
    attempts.push({ branch, identifierKind, identifierValue, lookup });
  };

  if (event.eventType === 'checkout.session.completed') {
    pushAttempt(
      'match_checkout_session_primary',
      'checkout_session_id',
      event.checkoutSessionId,
      () => ctx.providers.repository.getPaymentByStripeCheckoutSessionId(event.checkoutSessionId!),
    );
    pushAttempt(
      'match_payment_intent_fallback_for_checkout',
      'payment_intent_id',
      event.paymentIntentId,
      () => ctx.providers.repository.getPaymentByStripePaymentIntentId(event.paymentIntentId!),
    );
    pushAttempt(
      'match_booking_id_fallback_for_checkout',
      'booking_id',
      event.bookingId,
      () => ctx.providers.repository.getPaymentByBookingId(event.bookingId!),
    );
    return attempts;
  }

  if (event.eventType === 'invoice.paid') {
    pushAttempt(
      'match_invoice_primary_for_pay_later',
      'invoice_id',
      event.invoiceId,
      () => ctx.providers.repository.getPaymentByStripeInvoiceId(event.invoiceId!),
    );
    pushAttempt(
      'match_payment_intent_fallback_for_pay_later',
      'payment_intent_id',
      event.paymentIntentId,
      () => ctx.providers.repository.getPaymentByStripePaymentIntentId(event.paymentIntentId!),
    );
    return attempts;
  }

  pushAttempt(
    'match_invoice_primary_for_payment_intent',
    'invoice_id',
    event.invoiceId,
    () => ctx.providers.repository.getPaymentByStripeInvoiceId(event.invoiceId!),
  );
  pushAttempt(
    'match_payment_intent_primary',
    'payment_intent_id',
    event.paymentIntentId,
    () => ctx.providers.repository.getPaymentByStripePaymentIntentId(event.paymentIntentId!),
  );
  if (!event.invoiceId) {
    pushAttempt(
      'match_booking_id_fallback_for_payment_intent',
      'booking_id',
      event.bookingId,
      () => ctx.providers.repository.getPaymentByBookingId(event.bookingId!),
    );
  }
  return attempts;
}
