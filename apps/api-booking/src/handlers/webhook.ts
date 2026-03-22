import type { AppContext } from '../router.js';
import { ok } from '../lib/errors.js';
import type {
  StripePaymentWebhookEvent,
  StripeRefundWebhookEvent,
  StripeWebhookEvent,
} from '../providers/payments/interface.js';
import { resolveStripeRuntimeConfig } from '../providers/payments/runtime-config.js';
import type { Payment } from '../types.js';
import { backfillSettledPaymentArtifacts, confirmBookingPayment } from '../services/booking-service.js';
import { reconcileStripeRefundWebhook } from '../services/refund-service.js';

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

  const paymentMatch = event.eventCategory === 'payment'
    ? await findPaymentForStripePaymentEvent(event, ctx)
    : await findPaymentForStripeRefundEvent(event, ctx);
  const payment = paymentMatch.payment;
  if (!payment) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'stripe_webhook_request_completed',
      message: 'Stripe webhook event could not be reconciled to a payment row',
      context: {
        stripe_event_type: event.eventType,
        stripe_checkout_session_id: event.eventCategory === 'payment' ? event.checkoutSessionId : null,
        stripe_payment_intent_id: event.paymentIntentId,
        stripe_invoice_id: event.invoiceId,
        stripe_refund_id: event.eventCategory === 'refund' ? event.refundId : null,
        stripe_credit_note_id: event.eventCategory === 'refund' ? event.creditNoteId : null,
        booking_id: event.bookingId,
        attempted_match_branches: paymentMatch.attemptedBranches,
        branch_taken: paymentMatch.branchTaken,
        deny_reason: paymentMatch.denyReason,
      },
    });
    return ok({ received: true, handled: false });
  }

  if (event.eventCategory === 'refund') {
    const reconciliation = await reconcileStripeRefundWebhook(
      payment,
      event,
      {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        operation: ctx.operation,
        siteUrl: ctx.siteUrl,
      },
    );

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'stripe_webhook_request_completed',
      message: reconciliation.updated
        ? 'Stripe refund webhook reconciled local refund state'
        : reconciliation.branchTaken === 'skip_refund_webhook_without_local_initiation'
          ? 'Ignored Stripe refund webhook because refund initiation did not originate locally'
          : 'Stripe refund webhook was idempotent because local refund state was already current',
      context: {
        payment_id: payment.id,
        booking_id: payment.booking_id,
        stripe_event_type: event.eventType,
        stripe_refund_id: event.refundId,
        stripe_credit_note_id: event.creditNoteId,
        matched_branch: paymentMatch.branchTaken,
        branch_taken: reconciliation.updated
          ? 'refund_state_reconciled_via_shared_path'
          : reconciliation.branchTaken === 'skip_refund_webhook_without_local_initiation'
            ? 'skip_refund_webhook_without_local_initiation'
            : 'idempotent_refund_state_already_current',
        deny_reason: reconciliation.updated ? null : reconciliation.denyReason,
      },
    });
    return ok({ received: true, handled: true, idempotent: !reconciliation.updated });
  }

  if (payment.status === 'SUCCEEDED') {
    const artifactBackfill = await backfillSettledPaymentArtifacts(
      {
        id: payment.id,
        booking_id: payment.booking_id,
        status: payment.status,
        invoice_url: payment.invoice_url,
        stripe_receipt_url: payment.stripe_receipt_url,
        stripe_checkout_session_id: payment.stripe_checkout_session_id,
        stripe_payment_intent_id: payment.stripe_payment_intent_id,
        stripe_invoice_id: payment.stripe_invoice_id,
      },
      {
        paymentIntentId: event.paymentIntentId,
        invoiceId: event.invoiceId,
        invoiceUrl: event.invoiceUrl,
        receiptUrl: event.receiptUrl,
        rawPayload: event.rawPayload,
      },
      {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        operation: ctx.operation,
        siteUrl: event.siteUrl ?? ctx.siteUrl,
      },
    );

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'stripe_webhook_request_completed',
      message: artifactBackfill.updated
        ? 'Stripe webhook event backfilled invoice artifacts for an already-settled payment'
        : 'Stripe webhook event was idempotent because payment is already settled',
      context: {
        payment_id: payment.id,
        booking_id: payment.booking_id,
        stripe_event_type: event.eventType,
        matched_branch: paymentMatch.branchTaken,
        artifact_backfill_branch: artifactBackfill.branchTaken,
        branch_taken: artifactBackfill.updated
          ? 'backfilled_invoice_artifacts_for_succeeded_payment'
          : 'idempotent_already_succeeded',
        deny_reason: artifactBackfill.updated ? null : artifactBackfill.denyReason,
      },
    });
    return ok({
      received: true,
      handled: true,
      idempotent: !artifactBackfill.updated,
      artifacts_backfilled: artifactBackfill.updated,
    });
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
      receiptUrl: event.receiptUrl,
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

type StripeWebhookLookupIdentifierKind =
  | 'checkout_session_id'
  | 'payment_intent_id'
  | 'invoice_id'
  | 'booking_id'
  | 'refund_id'
  | 'credit_note_id';

interface StripeWebhookLookupAttempt {
  branch: string;
  identifierKind: StripeWebhookLookupIdentifierKind;
  identifierValue: string;
  lookup: () => Promise<Payment | null>;
}

async function findPaymentForStripePaymentEvent(
  event: StripePaymentWebhookEvent,
  ctx: AppContext,
): Promise<StripeWebhookPaymentMatchResult> {
  const attempts = buildStripeWebhookLookupPlanForPayment(event, ctx);

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

  return findPaymentFromLookupAttempts(event, attempts, ctx, 'payment');
}

async function findPaymentForStripeRefundEvent(
  event: StripeRefundWebhookEvent,
  ctx: AppContext,
): Promise<StripeWebhookPaymentMatchResult> {
  const attempts = buildStripeWebhookLookupPlanForRefund(event, ctx);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'stripe_webhook_payment_lookup_started',
    message: 'Started Stripe refund webhook payment reconciliation',
    context: {
      stripe_event_type: event.eventType,
      stripe_payment_intent_id: event.paymentIntentId,
      stripe_invoice_id: event.invoiceId,
      stripe_refund_id: event.refundId,
      stripe_credit_note_id: event.creditNoteId,
      booking_id: event.bookingId,
      attempted_match_branches: attempts.map((attempt) => attempt.branch),
      branch_taken: 'evaluate_refund_reconciliation_lookup_plan',
      deny_reason: null,
    },
  });

  return findPaymentFromLookupAttempts(event, attempts, ctx, 'refund');
}

async function findPaymentFromLookupAttempts(
  event: StripeWebhookEvent,
  attempts: StripeWebhookLookupAttempt[],
  ctx: AppContext,
  mode: 'payment' | 'refund',
): Promise<StripeWebhookPaymentMatchResult> {
  for (const attempt of attempts) {
    const payment = await attempt.lookup();
    if (!payment) continue;

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'stripe_webhook_payment_lookup_completed',
      message: mode === 'payment'
        ? 'Matched Stripe webhook event to payment row'
        : 'Matched Stripe refund webhook event to payment row',
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
      ? mode === 'payment'
        ? 'deny_missing_payment_match_after_lookup_plan'
        : 'deny_missing_refund_payment_match_after_lookup_plan'
      : mode === 'payment'
        ? 'deny_missing_reconciliation_identifiers'
        : 'deny_missing_refund_reconciliation_identifiers',
    attemptedBranches: attempts.map((attempt) => attempt.branch),
    denyReason: attempts.length > 0
      ? mode === 'payment'
        ? 'payment_not_found_for_webhook_identifiers'
        : 'payment_not_found_for_refund_webhook_identifiers'
      : mode === 'payment'
        ? 'webhook_event_missing_reconciliation_identifiers'
        : 'refund_webhook_event_missing_reconciliation_identifiers',
  };
}

function buildStripeWebhookLookupPlanForPayment(
  event: StripePaymentWebhookEvent,
  ctx: AppContext,
): StripeWebhookLookupAttempt[] {
  const attempts: StripeWebhookLookupAttempt[] = [];
  const pushAttempt = (
    branch: string,
    identifierKind: StripeWebhookLookupIdentifierKind,
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

function buildStripeWebhookLookupPlanForRefund(
  event: StripeRefundWebhookEvent,
  ctx: AppContext,
): StripeWebhookLookupAttempt[] {
  const attempts: StripeWebhookLookupAttempt[] = [];
  const pushAttempt = (
    branch: string,
    identifierKind: StripeWebhookLookupIdentifierKind,
    identifierValue: string | null,
    lookup: () => Promise<Payment | null>,
  ): void => {
    if (!identifierValue) return;
    attempts.push({ branch, identifierKind, identifierValue, lookup });
  };

  pushAttempt(
    'match_refund_primary',
    'refund_id',
    event.refundId,
    () => ctx.providers.repository.getPaymentByStripeRefundId(event.refundId!),
  );
  pushAttempt(
    'match_credit_note_primary',
    'credit_note_id',
    event.creditNoteId,
    () => ctx.providers.repository.getPaymentByStripeCreditNoteId(event.creditNoteId!),
  );
  pushAttempt(
    'match_invoice_fallback_for_refund',
    'invoice_id',
    event.invoiceId,
    () => ctx.providers.repository.getPaymentByStripeInvoiceId(event.invoiceId!),
  );
  pushAttempt(
    'match_payment_intent_fallback_for_refund',
    'payment_intent_id',
    event.paymentIntentId,
    () => ctx.providers.repository.getPaymentByStripePaymentIntentId(event.paymentIntentId!),
  );
  pushAttempt(
    'match_booking_id_fallback_for_refund',
    'booking_id',
    event.bookingId,
    () => ctx.providers.repository.getPaymentByBookingId(event.bookingId!),
  );
  return attempts;
}
