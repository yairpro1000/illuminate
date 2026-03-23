import type { BookingContext } from './booking-service.js';
import { appendBookingEventWithEffects } from './booking-transition.js';
import { getBookingPolicyConfig } from '../config/booking-policy.js';
import { isPaymentSettledStatus } from '../domain/payment-status.js';
import type {
  Booking,
  BookingEventRecord,
  Payment,
  RefundStatus,
} from '../types.js';
import type { BookingSideEffect } from '../types.js';
import type { BookingSideEffectQueueEntry } from './booking-event-workflow.js';
import type {
  StripeRefundWebhookEvent,
} from '../providers/payments/interface.js';

export interface CancellationRefundDecision {
  eligible: boolean;
  refundMode: 'full' | 'none';
  refundPath: 'credit_note' | 'direct_refund' | null;
  refundAmount: number | null;
  refundCurrency: string | null;
  refundReasonText: string;
  branchTaken: string;
  denyReason: string | null;
}

export interface CancellationRefundNoticeDecision {
  includeRefundNotice: boolean;
  refundDecision: CancellationRefundDecision;
  branchTaken: string;
  denyReason: string | null;
}

export interface CancellationRefundExecutionResult {
  decision: CancellationRefundDecision;
  nextSideEffects: BookingSideEffectQueueEntry[];
}

interface RefundCompletionPayload {
  refund_status: 'SUCCEEDED';
  refund_amount: number;
  refund_currency: string;
  refund_reason: string;
  refund_path: 'credit_note' | 'direct_refund';
  stripe_refund_id: string | null;
  stripe_credit_note_id: string | null;
  credit_note_number: string | null;
  credit_note_document_url: string | null;
  credit_note_url: string | null;
  receipt_url: string | null;
  invoice_id: string | null;
  payment_intent_id: string | null;
}

export function effectiveRefundStatus(
  payment: Pick<Payment, 'refund_status' | 'status'> | null | undefined,
): RefundStatus {
  if (!payment) return 'NONE';
  if (payment.refund_status) return payment.refund_status;
  return payment.status === 'REFUNDED' ? 'SUCCEEDED' : 'NONE';
}

async function resolveRefundArtifactUrls(
  payment: Payment,
  event: Pick<StripeRefundWebhookEvent, 'eventType' | 'paymentIntentId' | 'invoiceId' | 'receiptUrl' | 'creditNoteDocumentUrl'>,
  ctx: Pick<BookingContext, 'providers' | 'logger'>,
): Promise<{
  receiptUrl: string | null;
  creditNoteUrl: string | null;
  branchTaken: string;
  denyReason: string | null;
}> {
  const existingReceiptUrl = payment.stripe_receipt_url ?? null;
  const existingCreditNoteUrl = payment.stripe_credit_note_url ?? null;
  const upstreamReceiptUrl = event.receiptUrl ?? null;
  const upstreamCreditNoteUrl = event.creditNoteDocumentUrl ?? null;

  if (upstreamReceiptUrl || upstreamCreditNoteUrl) {
    return {
      receiptUrl: upstreamReceiptUrl ?? existingReceiptUrl,
      creditNoteUrl: upstreamCreditNoteUrl ?? existingCreditNoteUrl,
      branchTaken: upstreamCreditNoteUrl
        ? 'reuse_upstream_credit_note_url'
        : 'reuse_upstream_receipt_url',
      denyReason: null,
    };
  }

  if (existingReceiptUrl || existingCreditNoteUrl) {
    return {
      receiptUrl: existingReceiptUrl,
      creditNoteUrl: existingCreditNoteUrl,
      branchTaken: existingCreditNoteUrl
        ? 'reuse_existing_credit_note_url'
        : 'reuse_existing_receipt_url',
      denyReason: null,
    };
  }

  const paymentIntentId = event.paymentIntentId ?? payment.stripe_payment_intent_id ?? null;
  const invoiceId = event.invoiceId ?? payment.stripe_invoice_id ?? null;
  if (!paymentIntentId && !invoiceId) {
    return {
      receiptUrl: null,
      creditNoteUrl: null,
      branchTaken: 'skip_refund_artifact_fetch_without_identifiers',
      denyReason: 'refund_artifact_identifiers_missing',
    };
  }

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'refund_artifact_fetch_decision',
    message: 'Fetching Stripe refund artifacts because stored customer-facing links are missing',
    context: {
      booking_id: payment.booking_id,
      payment_id: payment.id,
      stripe_event_type: event.eventType,
      stripe_payment_intent_id: paymentIntentId,
      stripe_invoice_id: invoiceId,
      branch_taken: 'fetch_refund_receipt_artifact_from_provider',
      deny_reason: 'refund_artifact_urls_missing',
    },
  });

  try {
    const artifacts = await ctx.providers.payments.getPaymentArtifactDetails({
      paymentIntentId,
      invoiceId,
    });
    const resolvedReceiptUrl = artifacts.receiptUrl ?? null;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'refund_artifact_fetch_completed',
      message: 'Fetched Stripe refund artifacts from payments provider',
      context: {
        booking_id: payment.booking_id,
        payment_id: payment.id,
        stripe_event_type: event.eventType,
        stripe_payment_intent_id: artifacts.paymentIntentId ?? paymentIntentId,
        stripe_invoice_id: artifacts.invoiceId ?? invoiceId,
        resolved_receipt_url_present: Boolean(resolvedReceiptUrl),
        branch_taken: resolvedReceiptUrl
          ? 'fetched_refund_receipt_url_from_provider'
          : 'provider_refund_receipt_url_missing_after_fetch',
        deny_reason: resolvedReceiptUrl ? null : 'provider_refund_receipt_url_missing',
      },
    });
    return {
      receiptUrl: resolvedReceiptUrl,
      creditNoteUrl: null,
      branchTaken: resolvedReceiptUrl
        ? 'fetched_refund_receipt_url_from_provider'
        : 'provider_refund_receipt_url_missing_after_fetch',
      denyReason: resolvedReceiptUrl ? null : 'provider_refund_receipt_url_missing',
    };
  } catch (error) {
    const denyReason = error instanceof Error ? error.message : 'provider_refund_artifact_fetch_failed';
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'refund_artifact_fetch_completed',
      message: 'Stripe refund artifact fetch failed; continuing without document links',
      context: {
        booking_id: payment.booking_id,
        payment_id: payment.id,
        stripe_event_type: event.eventType,
        stripe_payment_intent_id: paymentIntentId,
        stripe_invoice_id: invoiceId,
        branch_taken: 'provider_refund_artifact_fetch_failed',
        deny_reason: denyReason,
      },
    });
    return {
      receiptUrl: null,
      creditNoteUrl: null,
      branchTaken: 'provider_refund_artifact_fetch_failed',
      denyReason,
    };
  }
}

export async function evaluateCancellationRefundDecision(
  booking: Booking,
  payment: Payment | null,
  ctx: Pick<BookingContext, 'providers' | 'bookingPolicyConfig' | 'bookingPolicyConfigPromise' | 'logger'>,
): Promise<CancellationRefundDecision> {
  const bookingPolicy = await resolveBookingPolicyForRefundDecision(ctx);
  const lockWindowHours = bookingPolicy.selfServiceLockWindowHours;
  const hoursBeforeStart = (new Date(booking.starts_at).getTime() - Date.now()) / 3_600_000;
  const isOutsideNonRefundableWindow = hoursBeforeStart >= lockWindowHours;
  const currentRefundStatus = effectiveRefundStatus(payment);

  if (!payment) {
    return {
      eligible: false,
      refundMode: 'none',
      refundPath: null,
      refundAmount: null,
      refundCurrency: null,
      refundReasonText: 'Automatic refund skipped because no payment record existed for this cancellation.',
      branchTaken: 'skip_no_payment_record',
      denyReason: 'payment_record_missing',
    };
  }

  if (currentRefundStatus !== 'NONE') {
    return {
      eligible: false,
      refundMode: 'none',
      refundPath: null,
      refundAmount: payment.refund_amount ?? null,
      refundCurrency: payment.refund_currency ?? null,
      refundReasonText: currentRefundStatus === 'FAILED'
        ? 'Automatic refund skipped because a previous refund attempt already failed and no retry path is enabled.'
        : 'Automatic refund skipped because a refund has already been initiated for this payment.',
      branchTaken: currentRefundStatus === 'FAILED'
        ? 'skip_existing_failed_refund_without_retry_path'
        : 'skip_existing_refund_state',
      denyReason: currentRefundStatus === 'FAILED'
        ? 'refund_retry_not_supported'
        : 'refund_already_initialized',
    };
  }

  if (payment.provider !== 'stripe') {
    return {
      eligible: false,
      refundMode: 'none',
      refundPath: null,
      refundAmount: null,
      refundCurrency: null,
      refundReasonText: 'Automatic refund skipped because the payment provider is not Stripe.',
      branchTaken: 'skip_non_stripe_payment_provider',
      denyReason: 'payment_provider_not_stripe',
    };
  }

  if (!isPaymentSettledStatus(payment.status) || payment.status === 'REFUNDED') {
    return {
      eligible: false,
      refundMode: 'none',
      refundPath: null,
      refundAmount: null,
      refundCurrency: null,
      refundReasonText: 'Automatic refund skipped because the payment was not settled through Stripe.',
      branchTaken: 'skip_payment_not_settled_in_stripe',
      denyReason: 'payment_not_settled',
    };
  }

  if (!isOutsideNonRefundableWindow) {
    return {
      eligible: false,
      refundMode: 'none',
      refundPath: null,
      refundAmount: null,
      refundCurrency: null,
      refundReasonText: `Automatic refund skipped because the cancellation happened within the ${lockWindowHours}-hour non-refundable window.`,
      branchTaken: 'skip_inside_non_refundable_lock_window',
      denyReason: 'inside_non_refundable_lock_window',
    };
  }

  if (payment.amount <= 0) {
    return {
      eligible: false,
      refundMode: 'none',
      refundPath: null,
      refundAmount: null,
      refundCurrency: null,
      refundReasonText: 'Automatic refund skipped because the settled payment amount was zero.',
      branchTaken: 'skip_zero_amount_payment',
      denyReason: 'payment_amount_zero',
    };
  }

  const refundPath = payment.stripe_invoice_id
    ? 'credit_note'
    : payment.stripe_payment_intent_id
      ? 'direct_refund'
      : null;

  if (!refundPath) {
    return {
      eligible: false,
      refundMode: 'none',
      refundPath: null,
      refundAmount: null,
      refundCurrency: null,
      refundReasonText: 'Automatic refund skipped because required Stripe refund identifiers were missing.',
      branchTaken: 'skip_missing_stripe_refund_identifiers',
      denyReason: 'stripe_refund_identifiers_missing',
    };
  }

  return {
    eligible: true,
    refundMode: 'full',
    refundPath,
    refundAmount: payment.amount,
    refundCurrency: payment.currency,
    refundReasonText: `Full refund initiated because the cancellation happened before the ${lockWindowHours}-hour non-refundable window.`,
    branchTaken: refundPath === 'credit_note'
      ? 'initiate_invoice_credit_note_refund'
      : 'initiate_direct_payment_intent_refund',
    denyReason: null,
  };
}

export async function evaluateCancellationRefundNoticeDecision(
  booking: Booking,
  payment: Payment | null,
  ctx: Pick<BookingContext, 'providers' | 'bookingPolicyConfig' | 'bookingPolicyConfigPromise' | 'logger'>,
): Promise<CancellationRefundNoticeDecision> {
  const refundDecision = await evaluateCancellationRefundDecision(booking, payment, ctx);
  const currentRefundStatus = effectiveRefundStatus(payment);
  const includeRefundNotice = refundDecision.eligible
    || currentRefundStatus === 'PENDING'
    || currentRefundStatus === 'SUCCEEDED';

  return {
    includeRefundNotice,
    refundDecision,
    branchTaken: includeRefundNotice
      ? refundDecision.eligible
        ? 'include_refund_notice_for_newly_eligible_refund'
        : 'include_refund_notice_for_existing_refund_state'
      : 'skip_refund_notice_for_non_refundable_cancellation',
    denyReason: includeRefundNotice ? null : refundDecision.denyReason,
  };
}

export async function initiateAutomaticCancellationRefund(
  booking: Booking,
  ctx: BookingContext,
): Promise<CancellationRefundExecutionResult> {
  const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const decision = await evaluateCancellationRefundDecision(booking, payment, ctx);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'cancellation_refund_decision',
    message: 'Evaluated automatic refund initiation after cancellation',
    context: {
      booking_id: booking.id,
      payment_id: payment?.id ?? null,
      payment_provider: payment?.provider ?? null,
      payment_status: payment?.status ?? null,
      current_refund_status: effectiveRefundStatus(payment),
      stripe_invoice_id: payment?.stripe_invoice_id ?? null,
      stripe_payment_intent_id: payment?.stripe_payment_intent_id ?? null,
      eligible: decision.eligible,
      refund_mode: decision.refundMode,
      refund_path: decision.refundPath,
      refund_amount: decision.refundAmount,
      refund_currency: decision.refundCurrency,
      branch_taken: decision.branchTaken,
      deny_reason: decision.denyReason,
    },
  });

  if (!payment) {
    return { decision, nextSideEffects: [] };
  }

  await persistRefundDecisionState(payment, decision, ctx);

  if (!decision.eligible || !decision.refundAmount || !decision.refundCurrency) {
    return { decision, nextSideEffects: [] };
  }

  const refundRecord = await ctx.providers.payments.createRefund({
    bookingId: booking.id,
    paymentId: payment.id,
    amount: decision.refundAmount,
    currency: decision.refundCurrency,
    reasonText: decision.refundReasonText,
    siteUrl: resolveSiteUrl(ctx),
    stripeInvoiceId: payment.stripe_invoice_id,
    stripePaymentIntentId: payment.stripe_payment_intent_id,
    idempotencyKey: `booking:${booking.id}:refund`,
    metadata: {
      booking_id: booking.id,
      payment_id: payment.id,
      invoice_id: payment.stripe_invoice_id ?? '',
      payment_intent_id: payment.stripe_payment_intent_id ?? '',
    },
  });
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'cancellation_refund_provider_call_completed',
    message: 'Stripe refund provider call completed for canceled booking',
    context: {
      booking_id: booking.id,
      payment_id: payment.id,
      refund_path: refundRecord.refundPath,
      refund_status: refundRecord.refundStatus,
      stripe_refund_id: refundRecord.refundId,
      stripe_credit_note_id: refundRecord.creditNoteId,
      refund_amount: refundRecord.amount,
      refund_currency: refundRecord.currency,
      receipt_url_present: Boolean(refundRecord.receiptUrl),
      credit_note_url_present: Boolean(refundRecord.creditNoteDocumentUrl),
      branch_taken: refundRecord.refundPath === 'credit_note'
        ? 'refund_created_via_credit_note'
        : 'refund_created_via_direct_refund',
      deny_reason: null,
    },
  });

  const updatedPayment = await ctx.providers.repository.updatePayment(payment.id, {
    status: refundRecord.refundStatus === 'SUCCEEDED' ? 'REFUNDED' : payment.status,
    refund_status: refundRecord.refundStatus,
    refund_amount: refundRecord.amount,
    refund_currency: refundRecord.currency,
    stripe_refund_id: refundRecord.refundId,
    stripe_credit_note_id: refundRecord.creditNoteId,
    stripe_receipt_url: refundRecord.receiptUrl ?? payment.stripe_receipt_url ?? null,
    stripe_credit_note_url: refundRecord.creditNoteDocumentUrl ?? payment.stripe_credit_note_url ?? null,
    refunded_at: refundRecord.refundStatus === 'SUCCEEDED'
      ? (payment.refunded_at ?? new Date().toISOString())
      : payment.refunded_at,
    refund_reason: decision.refundReasonText,
  });
  let nextSideEffects: BookingSideEffectQueueEntry[] = [];
  if (refundRecord.refundStatus === 'SUCCEEDED') {
    const transition = await appendRefundCompletedEventIfNeeded(
      booking,
      updatedPayment,
      {
        refund_status: 'SUCCEEDED',
        refund_amount: refundRecord.amount,
        refund_currency: refundRecord.currency,
        refund_reason: decision.refundReasonText,
        refund_path: refundRecord.refundPath,
        stripe_refund_id: refundRecord.refundId,
        stripe_credit_note_id: refundRecord.creditNoteId,
        credit_note_number: refundRecord.creditNoteNumber,
        credit_note_document_url: refundRecord.creditNoteDocumentUrl,
        credit_note_url: refundRecord.creditNoteDocumentUrl,
        receipt_url: refundRecord.receiptUrl,
        invoice_id: refundRecord.invoiceId,
        payment_intent_id: refundRecord.paymentIntentId,
      },
      'SYSTEM',
      ctx,
    );
    nextSideEffects = transition
      ? transition.sideEffects.map((effect) => ({
        effect,
        event: transition.event,
        isFresh: true,
      }))
      : [];
  }

  return {
    decision,
    nextSideEffects,
  };
}

export async function reconcileStripeRefundWebhook(
  payment: Payment,
  event: StripeRefundWebhookEvent,
  ctx: BookingContext,
): Promise<{ updated: boolean; branchTaken: string; denyReason: string | null }> {
  const currentRefundStatus = effectiveRefundStatus(payment);
  const locallyInitiated = currentRefundStatus !== 'NONE'
    || Boolean(payment.stripe_refund_id)
    || Boolean(payment.stripe_credit_note_id);
  if (!locallyInitiated) {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'stripe_refund_webhook_reconciliation_decision',
      message: 'Ignored Stripe refund webhook because no local refund initiation exists',
      context: {
        booking_id: payment.booking_id,
        payment_id: payment.id,
        stripe_event_type: event.eventType,
        stripe_refund_id: event.refundId,
        stripe_credit_note_id: event.creditNoteId,
        current_refund_status: currentRefundStatus,
        branch_taken: 'skip_refund_webhook_without_local_initiation',
        deny_reason: 'refund_not_initiated_locally',
      },
    });
    return {
      updated: false,
      branchTaken: 'skip_refund_webhook_without_local_initiation',
      denyReason: 'refund_not_initiated_locally',
    };
  }

  const artifactUrls = await resolveRefundArtifactUrls(payment, event, ctx);
  const nextRefundStatus = resolveRefundStatusFromWebhook(payment, event, currentRefundStatus);
  const shouldPersist = currentRefundStatus !== nextRefundStatus
    || (event.refundId && event.refundId !== payment.stripe_refund_id)
    || (event.creditNoteId && event.creditNoteId !== payment.stripe_credit_note_id)
    || (event.amount !== null && event.amount !== payment.refund_amount)
    || (event.currency && event.currency !== payment.refund_currency)
    || artifactUrls.receiptUrl !== (payment.stripe_receipt_url ?? null)
    || artifactUrls.creditNoteUrl !== (payment.stripe_credit_note_url ?? null);
  const branchTaken = shouldPersist
    ? event.eventType.startsWith('credit_note.')
      ? 'reconcile_credit_note_refund_event'
      : 'reconcile_refund_lifecycle_event'
    : 'skip_refund_webhook_without_state_change';
  const denyReason = shouldPersist ? null : 'refund_state_already_current';

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'stripe_refund_webhook_reconciliation_decision',
    message: 'Evaluated Stripe refund webhook reconciliation',
    context: {
      booking_id: payment.booking_id,
      payment_id: payment.id,
      stripe_event_type: event.eventType,
      stripe_refund_id: event.refundId,
      stripe_credit_note_id: event.creditNoteId,
      current_refund_status: currentRefundStatus,
      next_refund_status: nextRefundStatus,
      refund_amount_from_event: event.amount,
      refund_currency_from_event: event.currency,
      resolved_receipt_url_present: Boolean(artifactUrls.receiptUrl),
      resolved_credit_note_url_present: Boolean(artifactUrls.creditNoteUrl),
      artifact_branch_taken: artifactUrls.branchTaken,
      branch_taken: branchTaken,
      deny_reason: denyReason,
    },
  });

  if (!shouldPersist) {
    return { updated: false, branchTaken, denyReason };
  }

  const updatedPayment = await ctx.providers.repository.updatePayment(payment.id, {
    status: nextRefundStatus === 'SUCCEEDED' ? 'REFUNDED' : payment.status,
    refund_status: nextRefundStatus,
    refund_amount: event.amount ?? payment.refund_amount,
    refund_currency: event.currency ?? payment.refund_currency,
    stripe_refund_id: event.refundId ?? payment.stripe_refund_id,
    stripe_credit_note_id: event.creditNoteId ?? payment.stripe_credit_note_id,
    stripe_receipt_url: artifactUrls.receiptUrl,
    stripe_credit_note_url: artifactUrls.creditNoteUrl,
    refunded_at: nextRefundStatus === 'SUCCEEDED'
      ? (payment.refunded_at ?? new Date().toISOString())
      : payment.refunded_at,
  });

  if (nextRefundStatus === 'SUCCEEDED') {
    const booking = await ctx.providers.repository.getBookingById(payment.booking_id);
    if (booking) {
    await appendRefundCompletedEventIfNeeded(
      booking,
      updatedPayment,
      {
        refund_status: 'SUCCEEDED',
        refund_amount: event.amount ?? updatedPayment.refund_amount ?? payment.amount,
        refund_currency: event.currency ?? updatedPayment.refund_currency ?? payment.currency,
        refund_reason: updatedPayment.refund_reason ?? 'Refund processed through Stripe reconciliation.',
        refund_path: event.creditNoteId ? 'credit_note' : 'direct_refund',
        stripe_refund_id: event.refundId ?? updatedPayment.stripe_refund_id ?? null,
        stripe_credit_note_id: event.creditNoteId ?? updatedPayment.stripe_credit_note_id ?? null,
        credit_note_number: event.creditNoteNumber,
        credit_note_document_url: event.creditNoteDocumentUrl,
        credit_note_url: artifactUrls.creditNoteUrl,
        receipt_url: artifactUrls.receiptUrl,
        invoice_id: event.invoiceId ?? updatedPayment.stripe_invoice_id,
        payment_intent_id: event.paymentIntentId ?? updatedPayment.stripe_payment_intent_id,
      },
      'WEBHOOK',
      ctx,
    );
    }
  }

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'stripe_refund_webhook_reconciliation_completed',
    message: 'Persisted Stripe refund webhook reconciliation',
    context: {
      booking_id: payment.booking_id,
      payment_id: payment.id,
      stripe_event_type: event.eventType,
      refund_status: nextRefundStatus,
      stripe_refund_id: updatedPayment.stripe_refund_id ?? null,
      stripe_credit_note_id: updatedPayment.stripe_credit_note_id ?? null,
      stripe_receipt_url_present: Boolean(updatedPayment.stripe_receipt_url),
      stripe_credit_note_url_present: Boolean(updatedPayment.stripe_credit_note_url),
      artifact_branch_taken: artifactUrls.branchTaken,
      branch_taken: branchTaken,
      deny_reason: null,
    },
  });

  return { updated: true, branchTaken, denyReason: null };
}

function resolveRefundStatusFromWebhook(
  payment: Payment,
  event: StripeRefundWebhookEvent,
  currentRefundStatus: RefundStatus,
): RefundStatus {
  if (!event.eventType.startsWith('credit_note.')) {
    return event.refundStatus ?? currentRefundStatus;
  }

  if (event.eventType === 'credit_note.voided') {
    const hasActualRefundOutcome = currentRefundStatus === 'SUCCEEDED'
      || currentRefundStatus === 'FAILED'
      || Boolean(event.refundId)
      || Boolean(payment.stripe_refund_id);
    return hasActualRefundOutcome ? currentRefundStatus : 'CANCELED';
  }

  return currentRefundStatus;
}

export async function sendRefundConfirmationEmailForBooking(
  booking: Booking,
  event: Pick<BookingEventRecord, 'payload'>,
  ctx: BookingContext,
): Promise<void> {
  const payload = event.payload ?? {};
  const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);

  if (!payment || effectiveRefundStatus(payment) !== 'SUCCEEDED') {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'refund_confirmation_email_decision',
      message: 'Skipped refund confirmation email because refund is not in succeeded state',
      context: {
        booking_id: booking.id,
        payment_id: payment?.id ?? null,
        current_refund_status: effectiveRefundStatus(payment),
        branch_taken: 'skip_refund_email_not_succeeded',
        deny_reason: 'refund_not_succeeded',
      },
    });
    return;
  }

  const subjectTitle = await resolveRefundSubjectTitle(booking, ctx);
  await ctx.providers.email.sendRefundConfirmation(booking, {
    subjectTitle,
    amount: readPayloadAmount(payload, payment.refund_amount ?? payment.amount),
    currency: readPayloadCurrency(payload, payment.refund_currency ?? payment.currency),
    explanation: readPayloadString(payload, 'refund_path') === 'credit_note'
      ? 'Your refund has been processed and a credit note was created.'
      : 'Your refund has been processed.',
    invoiceReference: readPayloadString(payload, 'invoice_id') ?? payment.stripe_invoice_id,
    creditNoteReference: readPayloadString(payload, 'credit_note_number')
      ?? readPayloadString(payload, 'stripe_credit_note_id')
      ?? payment.stripe_credit_note_id,
    refundReference: readPayloadString(payload, 'stripe_refund_id') ?? payment.stripe_refund_id,
    creditNoteUrl: readPayloadString(payload, 'credit_note_url')
      ?? readPayloadString(payload, 'credit_note_document_url')
      ?? payment.stripe_credit_note_url,
    receiptUrl: readPayloadString(payload, 'receipt_url') ?? payment.stripe_receipt_url,
  });
}

async function persistRefundDecisionState(
  payment: Payment,
  decision: CancellationRefundDecision,
  ctx: BookingContext,
): Promise<void> {
  const nextRefundStatus = effectiveRefundStatus(payment);
  const nextReason = decision.refundReasonText;
  const needsUpdate = (payment.refund_status ?? null) !== nextRefundStatus || payment.refund_reason !== nextReason;
  if (!needsUpdate) return;

  await ctx.providers.repository.updatePayment(payment.id, {
    refund_status: nextRefundStatus,
    refund_reason: nextReason,
  });
}

async function appendRefundCompletedEventIfNeeded(
  booking: Booking,
  payment: Payment,
  payload: RefundCompletionPayload,
  source: 'SYSTEM' | 'WEBHOOK',
  ctx: BookingContext,
): Promise<{ event: BookingEventRecord; sideEffects: BookingSideEffect[] } | null> {
  const existingEvents = await ctx.providers.repository.listBookingEvents(booking.id);
  const alreadyRecorded = existingEvents.some((event) =>
    event.event_type === 'REFUND_COMPLETED'
    && (
      (payload.stripe_refund_id && event.payload?.['stripe_refund_id'] === payload.stripe_refund_id)
      || (payload.stripe_credit_note_id && event.payload?.['stripe_credit_note_id'] === payload.stripe_credit_note_id)
    ),
  );
  if (alreadyRecorded) {
    return null;
  }

  const transition = await appendBookingEventWithEffects(
    booking.id,
    'REFUND_COMPLETED',
    source,
    payload as unknown as Record<string, unknown>,
    ctx,
    {
      booking,
      payment,
      policy: ctx.bookingPolicyConfig,
    },
  );
  return {
    event: transition.event,
    sideEffects: transition.sideEffects,
  };
}

async function resolveRefundSubjectTitle(booking: Booking, ctx: BookingContext): Promise<string> {
  if (booking.event_id) {
    const event = await ctx.providers.repository.getEventById(booking.event_id);
    return event?.title ?? 'your booking';
  }

  if (booking.session_type_title?.trim()) return booking.session_type_title.trim();
  if (booking.session_type_id) {
    const sessionType = await ctx.providers.repository.getSessionTypeById(booking.session_type_id);
    if (sessionType?.title?.trim()) return sessionType.title.trim();
  }

  return 'your session';
}

function resolveSiteUrl(ctx: Pick<BookingContext, 'siteUrl' | 'env'>): string {
  return String(ctx.siteUrl || ctx.env.SITE_URL || '').replace(/\/+$/g, '');
}

async function resolveBookingPolicyForRefundDecision(
  ctx: Pick<BookingContext, 'providers' | 'bookingPolicyConfig' | 'bookingPolicyConfigPromise' | 'logger'>,
) {
  if (ctx.bookingPolicyConfig) {
    return ctx.bookingPolicyConfig;
  }
  if (ctx.bookingPolicyConfigPromise) {
    return ctx.bookingPolicyConfigPromise;
  }
  return getBookingPolicyConfig(ctx.providers.repository);
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readPayloadAmount(payload: Record<string, unknown>, fallback: number): number {
  const value = payload['refund_amount'];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readPayloadCurrency(payload: Record<string, unknown>, fallback: string): string {
  const value = payload['refund_currency'];
  return typeof value === 'string' && value.trim() ? value : fallback;
}
