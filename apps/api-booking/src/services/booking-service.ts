import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import {
  consumeLatestProviderApiLogId,
  extendOperationContext,
  loggerForOperation,
  type OperationContext,
} from '../lib/execution.js';
import { syncApiLogOperationReferences } from '../lib/technical-observability.js';
import type {
  Booking,
  BookingCurrentStatus,
  BookingEffectIntent,
  BookingEventType,
  BookingSideEffect,
  Event,
  Payment,
  PaymentStatus,
  SessionTypeRecord,
} from '../types.js';
import { RetryableCalendarWriteError, isRetryableCalendarWriteError, type CalendarEvent } from '../providers/calendar/interface.js';
import { createAdminManageToken, generateToken, hashToken, verifyAdminManageToken } from './token-service.js';
import { ApiError, badRequest, conflict, gone, notFound } from '../lib/errors.js';
import { isEventPublished, normalizeEventRow } from '../lib/content-status.js';
import { appendBookingEventWithEffects } from './booking-transition.js';
import { isTerminalStatus } from '../domain/booking-domain.js';
import {
  getBookingPolicyConfig,
  getBookingPolicyText,
  maxAttemptsForEffectIntent,
  isCalendarWriteEffectIntent,
  shouldReserveSlotForTransition,
} from '../domain/booking-effect-policy.js';
import {
  isPaymentContinuableOnline,
  isPaymentDueTrackedStatus,
  isPaymentManualArrangementStatus,
  isPaymentSettledStatus,
} from '../domain/payment-status.js';
import {
  inferEntityFromIntent,
} from '../providers/repository/interface.js';
import { applyCouponToPrice, normalizeCouponCode, resolveCouponByCode } from './coupon-service.js';
import { computePaymentDueReminderTime } from './reminder-service.js';
import { recordSideEffectAttempts } from './side-effect-attempts.js';
import {
  evaluateCancellationRefundNoticeDecision,
  initiateAutomaticCancellationRefund,
  sendRefundConfirmationEmailForBooking,
} from './refund-service.js';
import {
  assertSessionTypeWeekCapacityAvailable,
  localWeekRangeForSlot,
  resolvePublicSessionTypeForBooking,
} from './session-availability.js';

const CRON_MANAGED_SIDE_EFFECT_INTENTS: ReadonlySet<BookingEffectIntent> = new Set([
  'SEND_PAYMENT_LINK',
  'SEND_PAYMENT_REMINDER',
  'SEND_EVENT_REMINDER',
  'VERIFY_EMAIL_CONFIRMATION',
  'VERIFY_STRIPE_PAYMENT',
]);
const REALTIME_TRANSITION_SIDE_EFFECT_INTENTS: ReadonlySet<BookingEffectIntent> = new Set([
  'SEND_BOOKING_CONFIRMATION_REQUEST',
  'RESERVE_CALENDAR_SLOT',
  'UPDATE_CALENDAR_SLOT',
  'CANCEL_CALENDAR_SLOT',
  'SEND_BOOKING_EXPIRATION_NOTIFICATION',
  'SEND_BOOKING_CANCELLATION_CONFIRMATION',
  'SEND_BOOKING_CONFIRMATION',
  'SEND_BOOKING_REFUND_CONFIRMATION',
  'CREATE_STRIPE_CHECKOUT',
  'CREATE_STRIPE_REFUND',
]);
const MAX_ACTIVE_CLIENT_SESSIONS_PER_WEEK = 2;
const MAX_INTRO_SESSIONS_PER_CLIENT = 1;
const INTRO_SESSION_REBOOK_EXCLUDED_STATUSES: readonly BookingCurrentStatus[] = ['CANCELED', 'EXPIRED', 'NO_SHOW'];

export interface BookingContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
  correlationId?: string;
  operation?: OperationContext;
  siteUrl?: string;
}

async function loadBookingPolicy(ctx: Pick<BookingContext, 'providers'>) {
  return getBookingPolicyConfig(ctx.providers.repository);
}

function bookingSiteUrl(ctx: Pick<BookingContext, 'siteUrl' | 'env'>): string {
  return String(ctx.siteUrl || ctx.env.SITE_URL || '').replace(/\/+$/g, '');
}

function withBookingOperationContext(ctx: BookingContext, bookingId: string): BookingContext {
  const operation = extendOperationContext(
    ctx.operation ?? {
      appArea: 'website',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId ?? ctx.requestId,
      bookingId: null,
      bookingEventId: null,
      sideEffectId: null,
      sideEffectAttemptId: null,
      latestProviderApiLogId: null,
      latestInboundErrorCode: null,
      latestInboundErrorMessage: null,
      latestEmailDispatch: null,
    },
    { bookingId },
  );
  return {
    ...ctx,
    operation,
    correlationId: operation.correlationId,
    logger: loggerForOperation(ctx.logger, operation),
  };
}

async function resolveSettlementPaymentArtifacts(
  input: Pick<PaymentSettlementInput, 'payment' | 'paymentIntentId' | 'invoiceId' | 'invoiceUrl' | 'receiptUrl'>,
  ctx: Pick<BookingContext, 'providers' | 'env' | 'logger'>,
): Promise<{
  paymentIntentId: string | null;
  invoiceId: string | null;
  invoiceUrl: string | null;
  receiptUrl: string | null;
  branchTaken: string;
  denyReason: string | null;
}> {
  const paymentIntentId = input.paymentIntentId ?? input.payment.stripe_payment_intent_id ?? null;
  const invoiceId = input.invoiceId ?? input.payment.stripe_invoice_id ?? null;
  const existingInvoiceUrl = input.invoiceUrl ?? input.payment.invoice_url ?? null;
  const existingReceiptUrl = input.receiptUrl ?? input.payment.stripe_receipt_url ?? null;

  if (existingInvoiceUrl && existingReceiptUrl) {
    return {
      paymentIntentId,
      invoiceId,
      invoiceUrl: existingInvoiceUrl,
      receiptUrl: existingReceiptUrl,
      branchTaken: input.invoiceUrl
        ? 'reuse_upstream_invoice_url'
        : 'reuse_existing_payment_invoice_url',
      denyReason: null,
    };
  }

  if (invoiceId || paymentIntentId) {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'payment_settlement_artifact_fetch_decision',
      message: 'Fetching Stripe payment artifacts because settlement input omitted customer-facing document URLs',
      context: {
        booking_id: input.payment.booking_id,
        payment_id: input.payment.id,
        stripe_payment_intent_id: paymentIntentId,
        stripe_invoice_id: invoiceId,
        payments_mode: ctx.env.PAYMENTS_MODE ?? null,
        existing_invoice_url_present: Boolean(existingInvoiceUrl),
        existing_receipt_url_present: Boolean(existingReceiptUrl),
        branch_taken: 'fetch_payment_artifacts_from_provider',
        deny_reason: !existingInvoiceUrl && !existingReceiptUrl
          ? 'payment_document_urls_missing_from_settlement_input'
          : !existingInvoiceUrl
            ? 'invoice_url_missing_from_settlement_input'
            : 'receipt_url_missing_from_settlement_input',
      },
    });
    try {
      const artifacts = await ctx.providers.payments.getPaymentArtifactDetails({
        paymentIntentId,
        invoiceId,
      });
      const resolvedInvoiceUrl = existingInvoiceUrl ?? artifacts.invoiceUrl;
      const resolvedReceiptUrl = existingReceiptUrl ?? artifacts.receiptUrl;
      const filledInvoiceUrl = !existingInvoiceUrl && Boolean(artifacts.invoiceUrl);
      const filledReceiptUrl = !existingReceiptUrl && Boolean(artifacts.receiptUrl);
      if (resolvedInvoiceUrl || resolvedReceiptUrl) {
        const branchTaken = filledInvoiceUrl
          ? 'fetched_invoice_url_from_provider'
          : filledReceiptUrl
            ? 'fetched_receipt_url_from_provider'
            : existingInvoiceUrl
              ? 'reuse_existing_payment_invoice_url'
              : 'reuse_upstream_invoice_url';
        ctx.logger.logInfo?.({
          source: 'backend',
          eventType: 'payment_settlement_artifact_fetch_completed',
          message: 'Fetched Stripe payment artifacts from payments provider',
          context: {
            booking_id: input.payment.booking_id,
            payment_id: input.payment.id,
            stripe_payment_intent_id: artifacts.paymentIntentId ?? paymentIntentId,
            stripe_invoice_id: artifacts.invoiceId ?? invoiceId,
            resolved_invoice_url_present: Boolean(resolvedInvoiceUrl),
            resolved_receipt_url_present: Boolean(resolvedReceiptUrl),
            branch_taken: branchTaken,
            deny_reason: null,
          },
        });
        return {
          paymentIntentId: artifacts.paymentIntentId ?? paymentIntentId,
          invoiceId: artifacts.invoiceId ?? invoiceId,
          invoiceUrl: resolvedInvoiceUrl,
          receiptUrl: resolvedReceiptUrl,
          branchTaken,
          denyReason: null,
        };
      }
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'payment_settlement_artifact_fetch_completed',
        message: 'Payments provider returned no customer-facing payment document URLs',
        context: {
          booking_id: input.payment.booking_id,
          payment_id: input.payment.id,
          stripe_payment_intent_id: paymentIntentId,
          stripe_invoice_id: invoiceId,
          resolved_invoice_url_present: false,
          resolved_receipt_url_present: false,
          branch_taken: 'provider_payment_artifacts_missing_after_fetch',
          deny_reason: 'provider_payment_artifacts_missing',
        },
      });
    } catch (error) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'payment_settlement_artifact_fetch_completed',
        message: 'Stripe payment artifact fetch failed; continuing without customer-facing document URLs',
        context: {
          booking_id: input.payment.booking_id,
          payment_id: input.payment.id,
          stripe_payment_intent_id: paymentIntentId,
          stripe_invoice_id: invoiceId,
          resolved_invoice_url_present: false,
          resolved_receipt_url_present: false,
          branch_taken: 'provider_payment_artifact_fetch_failed',
          deny_reason: error instanceof Error ? error.message : 'provider_payment_artifact_fetch_failed',
        },
      });
    }
  }

  return {
    paymentIntentId,
    invoiceId,
    invoiceUrl: existingInvoiceUrl,
    receiptUrl: existingReceiptUrl,
    branchTaken: invoiceId
      ? 'missing_invoice_url_non_mock_settlement'
      : paymentIntentId
        ? 'missing_receipt_url_non_mock_settlement'
        : 'missing_payment_artifacts_without_stripe_identifiers',
    denyReason: invoiceId
      ? 'invoice_url_missing_from_upstream_settlement'
      : paymentIntentId
        ? 'receipt_url_missing_from_upstream_settlement'
        : 'payment_artifact_identifiers_missing',
  };
}

// ── Session booking inputs ─────────────────────────────────────────────────

export interface PayNowInput {
  slotStart: string;
  slotEnd: string;
  timezone: string;
  sessionType: 'intro' | 'session';
  offerSlug?: string | null;
  clientName: string;
  clientEmail: string;
  clientPhone: string | null;
  reminderEmailOptIn: boolean;
  reminderWhatsappOptIn: boolean;
  turnstileToken: string;
  remoteIp: string | null;
  couponCode?: string | null;
}

export interface PayNowResult {
  bookingId: string;
  checkoutUrl: string;
  checkoutHoldExpiresAt: string;
}

export interface PayLaterInput {
  slotStart: string;
  slotEnd: string;
  timezone: string;
  sessionType: 'intro' | 'session';
  offerSlug?: string | null;
  clientName: string;
  clientEmail: string;
  clientPhone: string | null;
  reminderEmailOptIn: boolean;
  reminderWhatsappOptIn: boolean;
  turnstileToken: string;
  remoteIp: string | null;
  couponCode?: string | null;
}

export interface PayLaterResult {
  bookingId: string;
  status: BookingCurrentStatus;
}

// ── Event booking inputs ───────────────────────────────────────────────────

export interface EventBookingInput {
  event: Event;
  firstName: string;
  lastName: string | null;
  email: string;
  phone: string | null;
  reminderEmailOptIn: boolean;
  reminderWhatsappOptIn: boolean;
  turnstileToken: string;
  remoteIp: string | null;
  couponCode?: string | null;
}

export interface EventBookingResult {
  bookingId: string;
  status: BookingCurrentStatus;
  checkoutUrl?: string;
  checkoutHoldExpiresAt?: string;
}

export interface RescheduleInput {
  newStart: string;
  newEnd: string;
  timezone: string;
}

export interface BookingActionResult {
  ok: boolean;
  code: string;
  message: string;
  booking: Booking;
}

export interface CalendarSyncResult {
  booking: Booking;
  calendarSynced: boolean;
  failureReason: string | null;
  retryableFailure: boolean;
  retryableFailureReason: string | null;
}

export interface PublicCalendarEventInfo {
  title: string;
  start: string;
  end: string;
  timezone: string;
  location: string;
  description: string;
}

export interface BookingPublicActionInfo {
  booking: Booking;
  checkoutUrl: string | null;
  manageUrl: string | null;
  nextActionUrl: string | null;
  nextActionLabel: 'Complete Payment' | 'Manage Booking' | null;
  calendarEvent: PublicCalendarEventInfo | null;
  calendarSyncPendingRetry: boolean;
}

export interface ContinuePaymentActionInfo {
  booking: Booking;
  paymentStatus: string | null;
  paymentDueAt: string | null;
  manageUrl: string | null;
  checkoutUrl: string | null;
  canContinueToCheckout: boolean;
  branchTaken: string;
  denyReason: string | null;
}

interface PaymentSettlementInput {
  payment: Pick<
    Payment,
    | 'id'
    | 'booking_id'
    | 'status'
    | 'stripe_checkout_session_id'
    | 'stripe_payment_intent_id'
    | 'stripe_invoice_id'
  > & Partial<Pick<Payment, 'invoice_url' | 'stripe_receipt_url'>>;
  settlementSource: 'WEBHOOK' | 'ADMIN_UI' | 'SYSTEM';
  settledAt?: string;
  paymentIntentId?: string | null;
  invoiceId?: string | null;
  invoiceUrl?: string | null;
  receiptUrl?: string | null;
  rawPayload?: Record<string, unknown> | null;
}

async function resolveCommercialTerms(
  input: {
    basePrice: number;
    couponCode?: string | null;
    bookingKind: 'session' | 'event';
    paymentMode: 'free' | 'pay_now' | 'pay_later';
    subjectId: string;
  },
  ctx: BookingContext,
): Promise<{ basePrice: number; finalPrice: number; couponCode: string | null; currency: 'CHF' }> {
  const coupon = await resolveCouponByCode(input.couponCode, ctx.providers.repository, ctx.logger, {
    booking_kind: input.bookingKind,
    booking_subject_id: input.subjectId,
    requested_coupon_code: normalizeCouponCode(input.couponCode),
    payment_mode: input.paymentMode,
  });
  const pricing = applyCouponToPrice(input.basePrice, coupon);
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_price_snapshot_decision',
    message: 'Evaluated booking price snapshot and coupon application',
    context: {
      booking_kind: input.bookingKind,
      booking_subject_id: input.subjectId,
      payment_mode: input.paymentMode,
      requested_coupon_code: normalizeCouponCode(input.couponCode),
      applied_coupon_code: pricing.couponCode,
      base_price_chf: pricing.basePrice,
      final_price_chf: pricing.finalPrice,
      discount_percent: pricing.discountPercent,
      branch_taken: pricing.couponCode ? 'apply_coupon_discount' : 'use_base_price',
      deny_reason: pricing.couponCode ? null : 'coupon_not_applied',
    },
  });
  return {
    basePrice: pricing.basePrice,
    finalPrice: pricing.finalPrice,
    couponCode: pricing.couponCode,
    currency: 'CHF',
  };
}

function paymentProviderUrl(payment: Pick<Payment, 'invoice_url' | 'checkout_url'> | null | undefined): string | null {
  return payment?.invoice_url ?? payment?.checkout_url ?? null;
}

function paymentCheckoutUrlForContinuation(payment: Pick<Payment, 'checkout_url'> | null | undefined): string | null {
  return payment?.checkout_url ?? null;
}

function buildCheckoutSuccessUrl(siteUrl: string, bookingId: string): string {
  return `${siteUrl}/payment-success.html?booking_id=${encodeURIComponent(bookingId)}&session_id={CHECKOUT_SESSION_ID}`;
}

function buildCheckoutCancelUrl(siteUrl: string, bookingId: string): string {
  return `${siteUrl}/payment-cancel.html?booking_id=${encodeURIComponent(bookingId)}`;
}

function paymentEmailUrl(
  input: {
    booking: Pick<Booking, 'booking_type' | 'current_status' | 'id'>;
    payment: Pick<Payment, 'invoice_url' | 'checkout_url' | 'status'> | null | undefined;
    siteUrl: string;
  },
): { invoiceUrl: string | null; payUrl: string | null } {
  const invoiceUrl = input.payment?.invoice_url ?? null;
  const checkoutUrl = input.payment?.checkout_url ?? null;
  const canContinuePayLater = (
    input.booking.booking_type === 'PAY_LATER'
    && input.booking.current_status === 'CONFIRMED'
    && isPaymentContinuableOnline(input.payment?.status ?? null)
  );

  return {
    invoiceUrl,
    payUrl: checkoutUrl ?? (
      canContinuePayLater
        ? buildContinuePaymentUrl(input.siteUrl, input.booking as Booking)
        : null
    ),
  };
}

function canContinuePayLaterPayment(
  booking: Pick<Booking, 'booking_type' | 'current_status'>,
  paymentStatus: Payment['status'] | null | undefined,
): boolean {
  return booking.booking_type === 'PAY_LATER'
    && booking.current_status === 'CONFIRMED'
    && isPaymentContinuableOnline(paymentStatus ?? null);
}

async function assertClientWithinWeeklySessionLimit(
  input: {
    clientId: string;
    slotStart: string;
    timezone: string;
    sessionType: 'intro' | 'session';
    sessionTypeId: string;
    sessionTypeSlug: string;
  },
  ctx: BookingContext,
): Promise<void> {
  const weekRange = localWeekRangeForSlot(input.slotStart, input.timezone);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'client_weekly_session_limit_check_started',
    message: 'Checking per-client weekly 1:1 session limit',
    context: {
      client_id: input.clientId,
      requested_slot_start: input.slotStart,
      timezone: input.timezone,
      session_type: input.sessionType,
      session_type_id: input.sessionTypeId,
      session_type_slug: input.sessionTypeSlug,
      weekly_limit: MAX_ACTIVE_CLIENT_SESSIONS_PER_WEEK,
      week_start_date: weekRange.weekStartDate,
      week_end_exclusive_date: weekRange.weekEndExclusiveDate,
      week_start_inclusive_iso: weekRange.startInclusiveIso,
      week_end_exclusive_iso: weekRange.endExclusiveIso,
      branch_taken: 'count_client_sessions_for_local_week',
      deny_reason: null,
    },
  });

  const existingCount = await ctx.providers.repository.countClientActiveSessionBookingsInRange(
    input.clientId,
    weekRange.startInclusiveIso,
    weekRange.endExclusiveIso,
  );
  const wouldExceedLimit = existingCount >= MAX_ACTIVE_CLIENT_SESSIONS_PER_WEEK;
  const logEntry = {
    source: 'backend' as const,
    eventType: 'client_weekly_session_limit_check_completed',
    message: 'Completed per-client weekly 1:1 session limit check',
    context: {
      client_id: input.clientId,
      requested_slot_start: input.slotStart,
      timezone: input.timezone,
      session_type: input.sessionType,
      session_type_id: input.sessionTypeId,
      session_type_slug: input.sessionTypeSlug,
      weekly_limit: MAX_ACTIVE_CLIENT_SESSIONS_PER_WEEK,
      existing_active_session_count: existingCount,
      attempted_session_count: existingCount + 1,
      week_start_date: weekRange.weekStartDate,
      week_end_exclusive_date: weekRange.weekEndExclusiveDate,
      week_start_inclusive_iso: weekRange.startInclusiveIso,
      week_end_exclusive_iso: weekRange.endExclusiveIso,
      branch_taken: wouldExceedLimit
        ? 'deny_client_weekly_session_limit_reached'
        : 'allow_client_weekly_session_limit',
      deny_reason: wouldExceedLimit ? 'max_2_sessions_per_local_week_reached' : null,
    },
  };

  if (wouldExceedLimit) {
    ctx.logger.logWarn?.(logEntry);
    throw new ApiError(
      409,
      'CLIENT_WEEKLY_SESSION_LIMIT_REACHED',
      'A client can have at most 2 active 1:1 sessions in the same week.',
    );
  }

  ctx.logger.logInfo?.(logEntry);
}

async function assertClientCanBookIntroSession(
  input: {
    clientId: string;
    slotStart: string;
    timezone: string;
    sessionTypeId: string;
    sessionTypeSlug: string;
  },
  ctx: BookingContext,
): Promise<void> {
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'client_intro_session_limit_check_started',
    message: 'Checking per-client intro session booking limit',
    context: {
      client_id: input.clientId,
      requested_slot_start: input.slotStart,
      timezone: input.timezone,
      session_type: 'intro',
      session_type_id: input.sessionTypeId,
      session_type_slug: input.sessionTypeSlug,
      intro_limit: MAX_INTRO_SESSIONS_PER_CLIENT,
      excluded_statuses: [...INTRO_SESSION_REBOOK_EXCLUDED_STATUSES],
      branch_taken: 'count_client_intro_bookings',
      deny_reason: null,
    },
  });

  const existingCount = await ctx.providers.repository.countClientBookingsBySessionType(
    input.clientId,
    input.sessionTypeId,
    [...INTRO_SESSION_REBOOK_EXCLUDED_STATUSES],
  );
  const wouldExceedLimit = existingCount >= MAX_INTRO_SESSIONS_PER_CLIENT;
  const logEntry = {
    source: 'backend' as const,
    eventType: 'client_intro_session_limit_check_completed',
    message: 'Completed per-client intro session booking limit check',
    context: {
      client_id: input.clientId,
      requested_slot_start: input.slotStart,
      timezone: input.timezone,
      session_type: 'intro',
      session_type_id: input.sessionTypeId,
      session_type_slug: input.sessionTypeSlug,
      intro_limit: MAX_INTRO_SESSIONS_PER_CLIENT,
      excluded_statuses: [...INTRO_SESSION_REBOOK_EXCLUDED_STATUSES],
      existing_intro_booking_count: existingCount,
      attempted_intro_booking_count: existingCount + 1,
      branch_taken: wouldExceedLimit
        ? 'deny_client_intro_session_limit_reached'
        : 'allow_client_intro_session_limit',
      deny_reason: wouldExceedLimit ? 'client_already_has_non_rebookable_intro_booking' : null,
    },
  };

  if (wouldExceedLimit) {
    ctx.logger.logWarn?.(logEntry);
    throw new ApiError(
      409,
      'CLIENT_INTRO_SESSION_LIMIT_REACHED',
      'You can only book one intro session. If you need help with an existing intro booking, please contact me.',
    );
  }

  ctx.logger.logInfo?.(logEntry);
}

// ── Session flow: Pay Now ──────────────────────────────────────────────────

export async function createPayNowBooking(
  input: PayNowInput,
  ctx: BookingContext,
): Promise<PayNowResult> {
  const { providers, env } = ctx;

  if (input.sessionType === 'intro') {
    throw badRequest('Intro conversations are free and do not support pay-now checkout.');
  }

  await providers.antibot.verify(input.turnstileToken, input.remoteIp);
  await assertSlotAvailable(input.slotStart, input.slotEnd, providers);

  const { firstName, lastName } = splitFullName(input.clientName);
  const client = await upsertClient(
    { firstName, lastName, email: input.clientEmail, phone: input.clientPhone },
    providers,
  );

  const sessionType = await resolvePublicSessionTypeForBooking(providers.repository, {
    kind: 'session',
    offerSlug: input.offerSlug ?? null,
  });
  await assertSessionTypeWeekCapacityAvailable(
    providers.repository,
    sessionType,
    input.slotStart,
    sessionType.availability_timezone?.trim() || input.timezone || env.TIMEZONE,
    ctx.logger,
  );
  await assertClientWithinWeeklySessionLimit({
    clientId: client.id,
    slotStart: input.slotStart,
    timezone: input.timezone,
    sessionType: input.sessionType,
    sessionTypeId: sessionType.id,
    sessionTypeSlug: sessionType.slug,
  }, ctx);
  const commercialTerms = await resolveCommercialTerms({
    basePrice: sessionType.price,
    couponCode: input.couponCode,
    bookingKind: 'session',
    paymentMode: 'pay_now',
    subjectId: sessionType.id,
  }, ctx);
  const booking = await providers.repository.createBooking({
    client_id: client.id,
    event_id: null,
    session_type_id: sessionType.id,
    booking_type: 'PAY_NOW',
    starts_at: input.slotStart,
    ends_at: input.slotEnd,
    timezone: input.timezone,
    google_event_id: null,
    meeting_provider: null,
    meeting_link: null,
    address_line: env.SESSION_ADDRESS,
    maps_url: env.SESSION_MAPS_URL,
    price: commercialTerms.finalPrice,
    currency: commercialTerms.currency,
    coupon_code: commercialTerms.couponCode,
    current_status: 'PENDING',
    notes: null,
  });
  const bookingCtx = withBookingOperationContext(ctx, booking.id);

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    'BOOKING_FORM_SUBMITTED',
    'PUBLIC_UI',
    {
      payment_mode: 'pay_now',
      session_type_id: sessionType.id,
      session_type_slug: sessionType.slug,
    },
    bookingCtx,
  );

  const checkout = await ensureCheckoutForBooking(transitioned.booking, {
    title: sessionType.title,
    price: commercialTerms.finalPrice,
    currency: commercialTerms.currency,
    clientEmail: client.email,
    clientName: [client.first_name, client.last_name].filter(Boolean).join(' ') || client.email,
  }, bookingCtx);
  await markCheckoutSideEffectAttempt(transitioned.sideEffects, checkout.effectApiLogId, 'SUCCESS', null, bookingCtx);

  return {
    bookingId: transitioned.booking.id,
    checkoutUrl: checkout.checkoutUrl,
    checkoutHoldExpiresAt: checkout.expiresAt,
  };
}

// ── Session flow: Pay Later ────────────────────────────────────────────────

export async function createPayLaterBooking(
  input: PayLaterInput,
  ctx: BookingContext,
): Promise<PayLaterResult> {
  const { providers, env } = ctx;

  await providers.antibot.verify(input.turnstileToken, input.remoteIp);
  await assertSlotAvailable(input.slotStart, input.slotEnd, providers);

  const { firstName, lastName } = splitFullName(input.clientName);
  const client = await upsertClient(
    { firstName, lastName, email: input.clientEmail, phone: input.clientPhone },
    providers,
  );

  const sessionType = await resolvePublicSessionTypeForBooking(providers.repository, {
    kind: input.sessionType,
    offerSlug: input.offerSlug ?? null,
  });
  await assertSessionTypeWeekCapacityAvailable(
    providers.repository,
    sessionType,
    input.slotStart,
    sessionType.availability_timezone?.trim() || input.timezone || env.TIMEZONE,
    ctx.logger,
  );
  if (input.sessionType === 'intro') {
    await assertClientCanBookIntroSession({
      clientId: client.id,
      slotStart: input.slotStart,
      timezone: input.timezone,
      sessionTypeId: sessionType.id,
      sessionTypeSlug: sessionType.slug,
    }, ctx);
  }
  await assertClientWithinWeeklySessionLimit({
    clientId: client.id,
    slotStart: input.slotStart,
    timezone: input.timezone,
    sessionType: input.sessionType,
    sessionTypeId: sessionType.id,
    sessionTypeSlug: sessionType.slug,
  }, ctx);
  const commercialTerms = await resolveCommercialTerms({
    basePrice: sessionType.price,
    couponCode: input.couponCode,
    bookingKind: 'session',
    paymentMode: input.sessionType === 'intro' ? 'free' : 'pay_later',
    subjectId: sessionType.id,
  }, ctx);
  const confirmToken = generateToken();
  const confirmTokenHash = await hashToken(confirmToken);

  const booking = await providers.repository.createBooking({
    client_id: client.id,
    event_id: null,
    session_type_id: sessionType.id,
    booking_type: input.sessionType === 'intro' ? 'FREE' : 'PAY_LATER',
    starts_at: input.slotStart,
    ends_at: input.slotEnd,
    timezone: input.timezone,
    google_event_id: null,
    meeting_provider: null,
    meeting_link: null,
    address_line: env.SESSION_ADDRESS,
    maps_url: env.SESSION_MAPS_URL,
    price: commercialTerms.finalPrice,
    currency: commercialTerms.currency,
    coupon_code: commercialTerms.couponCode,
    current_status: 'PENDING',
    notes: null,
  });
  const bookingCtx = withBookingOperationContext(ctx, booking.id);

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    input.sessionType === 'intro' ? 'BOOKING_FORM_SUBMITTED' : 'BOOKING_FORM_SUBMITTED',
    'PUBLIC_UI',
    {
      payment_mode: input.sessionType === 'intro' ? 'free' : 'pay_later',
      session_type_id: sessionType.id,
      session_type_slug: sessionType.slug,
      confirm_token: confirmToken,
      confirm_token_hash: confirmTokenHash,
    },
    bookingCtx,
  );

  const finalizedBooking = await applyImmediateNonCronSideEffectsForTransition({
    transitionEventType: 'BOOKING_FORM_SUBMITTED',
    sourceOperation: 'create_pay_later_booking',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, bookingCtx);

  return {
    bookingId: finalizedBooking.id,
    status: finalizedBooking.current_status,
  };
}

// ── Event flow: normal booking ─────────────────────────────────────────────

export async function createEventBooking(
  input: EventBookingInput,
  ctx: BookingContext,
): Promise<EventBookingResult> {
  await ensureEventPublicBookable(input.event, ctx.providers.repository);
  return createEventBookingInternal(input, ctx, { viaLateAccess: false });
}

// ── Event flow: late-access booking ────────────────────────────────────────

export async function createEventBookingWithAccess(
  input: EventBookingInput,
  ctx: BookingContext,
): Promise<EventBookingResult> {
  return createEventBookingInternal(input, ctx, { viaLateAccess: true });
}

async function createEventBookingInternal(
  input: EventBookingInput,
  ctx: BookingContext,
  options: { viaLateAccess: boolean },
): Promise<EventBookingResult> {
  const { providers } = ctx;

  await providers.antibot.verify(input.turnstileToken, input.remoteIp);
  await ensureEventCapacity(input.event, providers);

  const client = await upsertClient(
    {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
    },
    providers,
  );
  const eventBasePrice = input.event.is_paid ? Number(input.event.price_per_person ?? 0) : 0;
  const commercialTerms = await resolveCommercialTerms({
    basePrice: eventBasePrice,
    couponCode: input.couponCode,
    bookingKind: 'event',
    paymentMode: input.event.is_paid ? 'pay_now' : 'free',
    subjectId: input.event.id,
  }, ctx);

  const booking = await providers.repository.createBooking({
    client_id: client.id,
    event_id: input.event.id,
    session_type_id: null,
    booking_type: input.event.is_paid ? 'PAY_NOW' : 'FREE',
    starts_at: input.event.starts_at,
    ends_at: input.event.ends_at,
    timezone: input.event.timezone,
    google_event_id: null,
    meeting_provider: null,
    meeting_link: null,
    address_line: input.event.address_line,
    maps_url: input.event.maps_url,
    price: commercialTerms.finalPrice,
    currency: commercialTerms.currency,
    coupon_code: commercialTerms.couponCode,
    current_status: 'PENDING',
    notes: null,
  });
  const bookingCtx = withBookingOperationContext(ctx, booking.id);

  if (!input.event.is_paid) {
    const confirmToken = options.viaLateAccess ? null : generateToken();
    const confirmTokenHash = confirmToken ? await hashToken(confirmToken) : null;

    const created = await appendBookingEventWithEffects(
      booking.id,
      'BOOKING_FORM_SUBMITTED',
      'PUBLIC_UI',
      {
        payment_mode: 'free',
        confirm_token: confirmToken,
        confirm_token_hash: confirmTokenHash,
        via_late_access: options.viaLateAccess,
      },
      bookingCtx,
    );
    const createdWithImmediateEffects = await applyImmediateNonCronSideEffectsForTransition({
      transitionEventType: 'BOOKING_FORM_SUBMITTED',
      sourceOperation: options.viaLateAccess ? 'create_event_booking_with_access' : 'create_event_booking',
      bookingBeforeTransition: booking,
      bookingAfterTransition: created.booking,
      transitionSideEffects: created.sideEffects,
    }, bookingCtx);

    if (options.viaLateAccess) {
      const confirmed = await bookingCtx.providers.repository.updateBooking(booking.id, {
        current_status: 'CONFIRMED',
      });
      await sendBookingFinalConfirmation(confirmed, bookingCtx);
      const finalized = confirmed;
      return { bookingId: finalized.id, status: finalized.current_status };
    }

    return { bookingId: createdWithImmediateEffects.id, status: createdWithImmediateEffects.current_status };
  }

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    'BOOKING_FORM_SUBMITTED',
    'PUBLIC_UI',
    {
      payment_mode: 'pay_now',
      event_id: input.event.id,
    },
    bookingCtx,
  );

  const checkout = await ensureCheckoutForBooking(
    transitioned.booking,
    {
      title: input.event.title,
      price: commercialTerms.finalPrice,
      currency: commercialTerms.currency,
      clientEmail: client.email,
      clientName: [client.first_name, client.last_name].filter(Boolean).join(' ') || client.email,
    },
    bookingCtx,
  );

  await markCheckoutSideEffectAttempt(transitioned.sideEffects, checkout.effectApiLogId, 'SUCCESS', null, bookingCtx);

  return {
    bookingId: transitioned.booking.id,
    status: transitioned.booking.current_status,
    checkoutUrl: checkout.checkoutUrl,
    checkoutHoldExpiresAt: checkout.expiresAt,
  };
}

// ── Confirm email token ────────────────────────────────────────────────────

export async function confirmBookingEmail(
  rawToken: string,
  ctx: BookingContext,
): Promise<Booking> {
  const policy = await loadBookingPolicy(ctx);
  const tokenHash = await hashToken(rawToken);
  const booking = await ctx.providers.repository.getBookingByConfirmTokenHash(tokenHash);
  if (!booking) throw notFound('Booking not found');
  const bookingCtx = withBookingOperationContext(ctx, booking.id);

  const bookingEvents = await bookingCtx.providers.repository.listBookingEvents(booking.id);
  const submissionWithToken = [...bookingEvents]
    .reverse()
    .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED' && event.payload?.['confirm_token_hash'] === tokenHash);
  const confirmationDeadlineIso = submissionWithToken
    ? new Date(
      new Date(submissionWithToken.created_at).getTime() +
      policy.nonPaidConfirmationWindowMinutes * 60_000,
    ).toISOString()
    : null;
  const isConfirmationWindowExpired = confirmationDeadlineIso
    ? Date.now() > new Date(confirmationDeadlineIso).getTime()
    : true;
  const calendarSyncPendingRetry = isSessionCalendarSyncPendingRetry(booking);

  bookingCtx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_email_confirmation_decision',
    message: 'Evaluated email confirmation token redemption',
    context: {
      booking_id: booking.id,
      booking_status: booking.current_status,
      has_google_event_id: Boolean(booking.google_event_id),
      has_submission_with_confirm_token: Boolean(submissionWithToken),
      confirmation_deadline: confirmationDeadlineIso,
      confirmation_window_minutes: policy.nonPaidConfirmationWindowMinutes,
      is_confirmation_window_expired: isConfirmationWindowExpired,
      branch_taken: booking.current_status !== 'PENDING'
        ? booking.current_status === 'CONFIRMED'
          ? (calendarSyncPendingRetry
            ? 'confirmed_booking_retry_calendar_sync_if_missing'
            : 'confirmed_booking_already_processed')
          : 'booking_already_progressed_or_terminal'
        : submissionWithToken
          ? (isConfirmationWindowExpired ? 'deny_confirmation_window_expired' : 'accept_confirmation_within_window')
          : 'deny_missing_submission_for_token',
      deny_reason: booking.current_status !== 'PENDING'
        ? booking.current_status === 'CONFIRMED'
          ? (calendarSyncPendingRetry ? 'calendar_sync_pending_retry' : null)
          : 'booking_not_confirmable_in_current_status'
        : submissionWithToken
          ? (isConfirmationWindowExpired ? 'confirmation_window_expired' : null)
          : 'confirm_token_submission_not_found',
    },
  });

  if (booking.current_status !== 'PENDING') {
    if (booking.current_status === 'CONFIRMED') {
      return retryCalendarSyncForConfirmedBookingIfMissing(booking, bookingCtx);
    }
    throw gone('This confirmation link is no longer valid');
  }

  if (!submissionWithToken || isConfirmationWindowExpired) {
    throw gone('This confirmation link is no longer valid');
  }

  const verificationOutcome = await completePendingEmailVerificationEffects(submissionWithToken.id, booking, bookingCtx);
  let finalizedBooking = verificationOutcome.bookingAfterVerification;
  if (booking.booking_type !== 'FREE') {
    const bootstrappedPayment = await ensurePayLaterInvoiceForBooking(finalizedBooking, bookingCtx, {
      bootstrapSource: 'booking_email_confirmation',
      allowProviderFailure: true,
    });
    finalizedBooking = bootstrappedPayment
      ? await bookingCtx.providers.repository.getBookingById(finalizedBooking.id) ?? finalizedBooking
      : finalizedBooking;

    await schedulePayLaterPaymentFollowups(finalizedBooking, submissionWithToken.id, bookingCtx);

    bookingCtx.logger.logInfo?.({
      source: 'backend',
      eventType: 'pay_later_confirmation_payment_bootstrap_completed',
      message: 'Completed pay-later confirmation payment bootstrap',
      context: {
        booking_id: finalizedBooking.id,
        booking_status: finalizedBooking.current_status,
        payment_id: bootstrappedPayment?.id ?? null,
        payment_status: bootstrappedPayment?.status ?? null,
        has_payment_url: Boolean(paymentProviderUrl(bootstrappedPayment)),
        has_invoice_url: Boolean(bootstrappedPayment?.invoice_url),
        branch_taken: bootstrappedPayment?.invoice_url
          ? 'confirmation_created_invoice_before_email'
          : 'confirmation_kept_pending_payment_without_invoice',
        deny_reason: bootstrappedPayment?.invoice_url ? null : 'invoice_bootstrap_failed_or_not_available',
      },
    });
  }

  finalizedBooking = await applyImmediateReservationForTransition({
    transitionEventType: 'BOOKING_FORM_SUBMITTED',
    sourceOperation: 'confirm_booking_email_verification',
    bookingBeforeTransition: booking,
    bookingAfterTransition: finalizedBooking,
    transitionSideEffects: verificationOutcome.downstreamSideEffects,
  }, bookingCtx);

  bookingCtx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_email_confirmation_sync_outcome',
    message: 'Completed synchronous confirmation handling and evaluated immediate calendar reservation outcome',
    context: {
      booking_id: finalizedBooking.id,
      booking_kind: finalizedBooking.event_id ? 'event' : 'session',
      current_status_after_confirmation: finalizedBooking.current_status,
      has_google_event_id_after_confirmation: Boolean(finalizedBooking.google_event_id),
      calendar_synced_immediately: finalizedBooking.event_id ? true : Boolean(finalizedBooking.google_event_id),
      branch_taken: finalizedBooking.event_id || finalizedBooking.google_event_id
        ? 'confirmation_completed_with_immediate_calendar_sync'
        : 'confirmation_completed_calendar_sync_pending_retry',
      deny_reason: finalizedBooking.event_id || finalizedBooking.google_event_id
        ? null
        : 'calendar_reservation_failed_or_not_written',
    },
  });

  return finalizedBooking;
}

// ── Payment success (webhook/dev) ──────────────────────────────────────────

export async function confirmBookingPayment(
  payment: Pick<
    Payment,
    | 'id'
    | 'booking_id'
    | 'status'
    | 'stripe_checkout_session_id'
    | 'stripe_payment_intent_id'
    | 'stripe_invoice_id'
  >,
  stripeData: {
    paymentIntentId: string | null;
    invoiceId: string | null;
    invoiceUrl: string | null;
    receiptUrl?: string | null;
    rawPayload?: Record<string, unknown> | null;
  },
  ctx: BookingContext,
): Promise<void> {
  await settleBookingPayment(
    {
      payment,
      settlementSource: 'WEBHOOK',
      paymentIntentId: stripeData.paymentIntentId,
      invoiceId: stripeData.invoiceId,
      invoiceUrl: stripeData.invoiceUrl,
      receiptUrl: stripeData.receiptUrl ?? null,
      rawPayload: stripeData.rawPayload ?? null,
    },
    ctx,
  );
}

export async function backfillSettledPaymentArtifacts(
  payment: Pick<
    Payment,
    | 'id'
    | 'booking_id'
    | 'status'
    | 'invoice_url'
    | 'stripe_receipt_url'
    | 'stripe_checkout_session_id'
    | 'stripe_payment_intent_id'
    | 'stripe_invoice_id'
  >,
  stripeData: {
    paymentIntentId: string | null;
    invoiceId: string | null;
    invoiceUrl: string | null;
    receiptUrl?: string | null;
    rawPayload?: Record<string, unknown> | null;
  },
  ctx: BookingContext,
): Promise<{ updated: boolean; branchTaken: string; denyReason: string | null }> {
  const { providers, logger } = ctx;
  const resolvedArtifacts = await resolveSettlementPaymentArtifacts(
    {
      payment,
      paymentIntentId: stripeData.paymentIntentId,
      invoiceId: stripeData.invoiceId,
      invoiceUrl: stripeData.invoiceUrl,
      receiptUrl: stripeData.receiptUrl ?? null,
    },
    ctx,
  );
  const nextPaymentIntentId = resolvedArtifacts.paymentIntentId ?? payment.stripe_payment_intent_id ?? null;
  const nextInvoiceId = resolvedArtifacts.invoiceId ?? payment.stripe_invoice_id ?? null;
  const nextInvoiceUrl = resolvedArtifacts.invoiceUrl ?? payment.invoice_url ?? null;
  const nextReceiptUrl = resolvedArtifacts.receiptUrl ?? payment.stripe_receipt_url ?? null;
  const hasArtifactDelta = nextPaymentIntentId !== (payment.stripe_payment_intent_id ?? null)
    || nextInvoiceId !== (payment.stripe_invoice_id ?? null)
    || nextInvoiceUrl !== (payment.invoice_url ?? null)
    || nextReceiptUrl !== (payment.stripe_receipt_url ?? null);
  const branchTaken = hasArtifactDelta
    ? resolvedArtifacts.branchTaken
    : 'skip_succeeded_payment_artifact_backfill_no_delta';
  const denyReason = hasArtifactDelta
    ? resolvedArtifacts.denyReason
    : 'succeeded_payment_artifacts_already_current_or_missing';

  logger.logInfo?.({
    source: 'backend',
    eventType: 'payment_succeeded_artifact_backfill_decision',
    message: 'Evaluated invoice artifact backfill for already-settled payment',
    context: {
      booking_id: payment.booking_id,
      payment_id: payment.id,
      payment_status: payment.status,
      stripe_checkout_session_id: payment.stripe_checkout_session_id,
      stripe_payment_intent_id: payment.stripe_payment_intent_id,
      stripe_invoice_id: payment.stripe_invoice_id,
      existing_invoice_url_present: Boolean(payment.invoice_url),
      existing_receipt_url_present: Boolean(payment.stripe_receipt_url),
      invoice_id_from_input: stripeData.invoiceId,
      invoice_url_from_input_present: Boolean(stripeData.invoiceUrl),
      receipt_url_from_input_present: Boolean(stripeData.receiptUrl),
      payment_intent_id_from_input: stripeData.paymentIntentId,
      resolved_invoice_id: nextInvoiceId,
      resolved_invoice_url_present: Boolean(nextInvoiceUrl),
      resolved_receipt_url_present: Boolean(nextReceiptUrl),
      branch_taken: branchTaken,
      deny_reason: denyReason,
    },
  });

  if (!hasArtifactDelta) {
    return { updated: false, branchTaken, denyReason };
  }

  await providers.repository.updatePayment(payment.id, {
    invoice_url: nextInvoiceUrl,
    stripe_receipt_url: nextReceiptUrl,
    stripe_payment_intent_id: nextPaymentIntentId,
    stripe_invoice_id: nextInvoiceId,
    raw_payload: {
      ...(stripeData.rawPayload ?? {}),
      settlement_source: 'WEBHOOK',
      artifact_backfill: true,
    },
  });

  logger.logInfo?.({
    source: 'backend',
    eventType: 'payment_succeeded_artifact_backfill_completed',
    message: 'Persisted invoice artifact backfill for already-settled payment',
    context: {
      booking_id: payment.booking_id,
      payment_id: payment.id,
      resolved_invoice_id: nextInvoiceId,
      resolved_invoice_url_present: Boolean(nextInvoiceUrl),
      resolved_receipt_url_present: Boolean(nextReceiptUrl),
      branch_taken: branchTaken,
      deny_reason: resolvedArtifacts.denyReason,
    },
  });

  return { updated: true, branchTaken, denyReason: resolvedArtifacts.denyReason };
}

export async function settleBookingPaymentManually(
  payment: Pick<
    Payment,
    | 'id'
    | 'booking_id'
    | 'status'
    | 'stripe_checkout_session_id'
    | 'stripe_payment_intent_id'
    | 'stripe_invoice_id'
  >,
  input: {
    invoiceUrl?: string | null;
    invoiceId?: string | null;
    receiptUrl?: string | null;
    note?: string | null;
    settledAt?: string | null;
  },
  ctx: BookingContext,
): Promise<void> {
  await settleBookingPayment(
    {
      payment,
      settlementSource: 'ADMIN_UI',
      settledAt: input.settledAt ?? undefined,
      invoiceId: input.invoiceId ?? null,
      invoiceUrl: input.invoiceUrl ?? null,
      receiptUrl: input.receiptUrl ?? null,
      rawPayload: {
        settlement_mode: 'manual_admin_action',
        settlement_note: input.note ?? null,
      },
    },
    ctx,
  );
}

async function settleBookingPayment(
  input: PaymentSettlementInput,
  ctx: BookingContext,
): Promise<void> {
  const { providers, logger } = ctx;
  const settledAt = input.settledAt ?? new Date().toISOString();
  const resolvedArtifacts = await resolveSettlementPaymentArtifacts(input, ctx);

  logger.logInfo?.({
    source: 'backend',
    eventType: 'payment_settlement_invoice_resolution_decision',
    message: 'Evaluated customer-facing payment artifact resolution for payment settlement',
    context: {
      booking_id: input.payment.booking_id,
      payment_id: input.payment.id,
      stripe_checkout_session_id: input.payment.stripe_checkout_session_id,
      stripe_payment_intent_id: input.payment.stripe_payment_intent_id,
      stripe_invoice_id: input.payment.stripe_invoice_id,
      payments_mode: ctx.env.PAYMENTS_MODE ?? null,
      invoice_id_from_input: input.invoiceId ?? null,
      invoice_url_from_input_present: Boolean(input.invoiceUrl),
      receipt_url_from_input_present: Boolean(input.receiptUrl),
      resolved_payment_intent_id: resolvedArtifacts.paymentIntentId,
      resolved_invoice_id: resolvedArtifacts.invoiceId,
      resolved_invoice_url_present: Boolean(resolvedArtifacts.invoiceUrl),
      resolved_receipt_url_present: Boolean(resolvedArtifacts.receiptUrl),
      branch_taken: resolvedArtifacts.branchTaken,
      deny_reason: resolvedArtifacts.denyReason,
    },
  });

  await providers.repository.updatePayment(input.payment.id, {
    status: 'SUCCEEDED',
    paid_at: settledAt,
    invoice_url: resolvedArtifacts.invoiceUrl,
    stripe_payment_intent_id: resolvedArtifacts.paymentIntentId ?? input.payment.stripe_payment_intent_id ?? null,
    stripe_invoice_id: resolvedArtifacts.invoiceId ?? input.payment.stripe_invoice_id ?? null,
    stripe_receipt_url: resolvedArtifacts.receiptUrl,
    raw_payload: {
      ...(input.rawPayload ?? {}),
      settlement_source: input.settlementSource,
    },
  });

  logger.logInfo?.({
    source: 'backend',
    eventType: 'payment_settlement_invoice_resolution_completed',
    message: 'Persisted customer-facing payment artifact resolution for payment settlement',
    context: {
      booking_id: input.payment.booking_id,
      payment_id: input.payment.id,
      resolved_payment_intent_id: resolvedArtifacts.paymentIntentId,
      resolved_invoice_id: resolvedArtifacts.invoiceId,
      resolved_invoice_url_present: Boolean(resolvedArtifacts.invoiceUrl),
      resolved_receipt_url_present: Boolean(resolvedArtifacts.receiptUrl),
      branch_taken: resolvedArtifacts.branchTaken,
      deny_reason: resolvedArtifacts.denyReason,
    },
  });

  const booking = await providers.repository.getBookingById(input.payment.booking_id);
  if (!booking) {
    logger.error('Booking not found for payment', { paymentId: input.payment.id });
    return;
  }
  const bookingCtx = withBookingOperationContext(ctx, booking.id);

  if (isTerminalStatus(booking.current_status)) {
    logger.warn('Late payment for inactive booking — not reviving', {
      bookingId: booking.id,
      current_status: booking.current_status,
      settlement_source: input.settlementSource,
    });

    await providers.repository.createBookingEvent({
      booking_id: booking.id,
      event_type: 'PAYMENT_SETTLED',
      source: input.settlementSource,
      payload: {
        late: true,
        prior_status: booking.current_status,
        payment_intent_id: resolvedArtifacts.paymentIntentId ?? null,
        invoice_id: resolvedArtifacts.invoiceId,
        invoice_url: resolvedArtifacts.invoiceUrl,
        receipt_url: resolvedArtifacts.receiptUrl,
        settled_at: settledAt,
      },
    });

    return;
  }

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    'PAYMENT_SETTLED',
    input.settlementSource,
    {
      prior_payment_status: input.payment.status,
      payment_intent_id: resolvedArtifacts.paymentIntentId ?? null,
      invoice_id: resolvedArtifacts.invoiceId,
      invoice_url: resolvedArtifacts.invoiceUrl,
      receipt_url: resolvedArtifacts.receiptUrl,
      settled_at: settledAt,
      ...(input.rawPayload ?? {}),
    },
    bookingCtx,
  );

  await applyImmediateReservationForTransition({
    transitionEventType: 'PAYMENT_SETTLED',
    sourceOperation: input.settlementSource === 'ADMIN_UI'
      ? 'admin_manual_payment_settlement'
      : 'confirm_booking_payment',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, bookingCtx);
}

// ── Manage-token resolution ────────────────────────────────────────────────

export async function resolveBookingByManageToken(
  rawToken: string,
  repository: Providers['repository'],
): Promise<Booking> {
  const parsed = parseStableManageToken(rawToken);
  const bookingId = parsed?.bookingId ?? rawToken;
  if (!isUuidLike(bookingId)) {
    throw badRequest('Invalid manage token');
  }

  const booking = await repository.getBookingById(bookingId);
  if (!booking) throw notFound('Booking not found');
  return booking;
}

export async function resolveBookingManageAccess(
  rawToken: string,
  rawAdminToken: string | null,
  ctx: BookingContext,
): Promise<{ booking: Booking; actorSource: 'PUBLIC_UI' | 'ADMIN_UI'; bypassPolicyWindow: boolean }> {
  const booking = await resolveBookingByManageToken(rawToken, ctx.providers.repository);
  if (!rawAdminToken) {
    return { booking, actorSource: 'PUBLIC_UI', bypassPolicyWindow: false };
  }
  const secret = String(ctx.env.ADMIN_MANAGE_TOKEN_SECRET || ctx.env.JOB_SECRET || '').trim();
  if (!secret) {
    return { booking, actorSource: 'PUBLIC_UI', bypassPolicyWindow: false };
  }
  const verified = await verifyAdminManageToken(rawAdminToken, secret);
  if (!verified || verified.bookingId !== booking.id) {
    return { booking, actorSource: 'PUBLIC_UI', bypassPolicyWindow: false };
  }
  return { booking, actorSource: 'ADMIN_UI', bypassPolicyWindow: true };
}

export async function buildAdminManageUrl(
  booking: Booking,
  ctx: BookingContext,
): Promise<{ url: string; adminToken: string; expiresAt: string }> {
  const policy = await loadBookingPolicy(ctx);
  const secret = String(ctx.env.ADMIN_MANAGE_TOKEN_SECRET || ctx.env.JOB_SECRET || '').trim();
  if (!secret) throw badRequest('Admin manage token secret is not configured');
  const expiresAt = new Date(
    Date.now() + policy.adminManageTokenExpiryMinutes * 60_000,
  ).toISOString();
  const adminToken = await createAdminManageToken(booking.id, secret, expiresAt);
  const manageToken = buildStableManageToken(booking.id);
  const url = `${bookingSiteUrl(ctx)}/manage.html?token=${encodeURIComponent(manageToken)}&admin_token=${encodeURIComponent(adminToken)}`;
  return { url, adminToken, expiresAt };
}

export async function cancelBooking(
  booking: Booking,
  ctx: BookingContext,
  options: { source?: 'PUBLIC_UI' | 'ADMIN_UI'; bypassPolicyWindow?: boolean } = {},
): Promise<BookingActionResult> {
  const source = options.source ?? 'PUBLIC_UI';
  const bookingPolicy = await loadBookingPolicy(ctx);
  const policy = evaluateManageBookingPolicy(booking.starts_at, bookingPolicy.selfServiceLockWindowHours);
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'cancel_booking_policy_gate_decision',
    message: 'Evaluated cancel booking policy gate',
    context: {
      booking_id: booking.id,
      booking_status: booking.current_status,
      starts_at: booking.starts_at,
      source,
      bypass_policy_window: Boolean(options.bypassPolicyWindow),
      can_self_serve_change: policy.canSelfServeChange,
      hours_before_start: policy.hoursBeforeStart,
      branch_taken: (!options.bypassPolicyWindow && !policy.canSelfServeChange) ? 'deny_policy_locked' : 'allow_policy_gate',
      deny_reason: (!options.bypassPolicyWindow && !policy.canSelfServeChange) ? 'starts_within_24h' : null,
    },
  });
  if (!options.bypassPolicyWindow && !policy.canSelfServeChange) {
    return {
      ok: false,
      code: 'BOOKING_POLICY_LOCKED',
      message: 'This session starts in less than 24 hours and cannot be changed online.',
      booking,
    };
  }

  if (isTerminalStatus(booking.current_status)) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'cancel_booking_status_gate_decision',
      message: 'Denied cancel booking because status is not cancellable',
      context: {
        booking_id: booking.id,
        booking_status: booking.current_status,
        source,
        branch_taken: 'deny_terminal_or_refunded_status',
        deny_reason: 'booking_status_not_cancellable',
      },
    });
    return {
      ok: false,
      code: 'INVALID_STATUS',
      message: `Booking cannot be cancelled in its current state (status: ${booking.current_status})`,
      booking,
    };
  }

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    'BOOKING_CANCELED',
    source,
    { reason: 'user_cancelled' },
    ctx,
  );
  const paymentBeforeImmediateEffects = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const refundNoticeDecision = await evaluateCancellationRefundNoticeDecision(
    transitioned.booking,
    paymentBeforeImmediateEffects,
    ctx,
  );

  let finalBooking = await applyImmediateNonCronSideEffectsForTransition({
    transitionEventType: 'BOOKING_CANCELED',
    sourceOperation: 'cancel_booking',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, ctx);

  const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'cancel_booking_refund_branch_decision',
    message: 'Evaluated refund branch during cancellation',
    context: {
      booking_id: booking.id,
      payment_id: payment?.id ?? null,
      payment_status: payment?.status ?? null,
      prior_booking_status: booking.current_status,
      source,
      refund_notice_included: refundNoticeDecision.includeRefundNotice,
      refund_eligible: refundNoticeDecision.refundDecision.eligible,
      refund_path: refundNoticeDecision.refundDecision.refundPath,
      refund_amount: refundNoticeDecision.refundDecision.refundAmount,
      branch_taken: refundNoticeDecision.branchTaken,
      deny_reason: refundNoticeDecision.denyReason,
    },
  });
  const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const includeRefundNotice = refundNoticeDecision.includeRefundNotice;

  return {
    ok: true,
    code: refreshedPayment?.status === 'REFUNDED' ? 'CANCELED_AND_REFUNDED' : 'CANCELED',
    message: includeRefundNotice
      ? 'Booking cancelled. If a refund applies, you\'ll receive a separate confirmation email.'
      : 'Booking cancelled.',
    booking: finalBooking,
  };
}

export async function expireBooking(
  booking: Booking,
  ctx: BookingContext,
): Promise<Booking> {
  const result = await appendBookingEventWithEffects(
    booking.id,
    'BOOKING_EXPIRED',
    'SYSTEM',
    { reason: 'side_effect_expired' },
    ctx,
  );

  const finalizedBooking = await applyImmediateNonCronSideEffectsForTransition({
    transitionEventType: 'BOOKING_EXPIRED',
    sourceOperation: 'expire_booking_verification',
    bookingBeforeTransition: booking,
    bookingAfterTransition: result.booking,
    transitionSideEffects: result.sideEffects,
  }, ctx);

  const expiryNotificationEffects = result.sideEffects
    .filter((effect) => effect.effect_intent === 'SEND_BOOKING_EXPIRATION_NOTIFICATION');

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_expiry_notification_sync_outcome',
    message: 'Completed synchronous expiry side effects and evaluated expiry email notification outcome',
    context: {
      booking_id: finalizedBooking.id,
      booking_kind: finalizedBooking.event_id ? 'event' : 'session',
      current_status_after_expiry: finalizedBooking.current_status,
      expiry_notification_effect_ids: expiryNotificationEffects.map((effect) => effect.id),
      expiry_notification_attempted_immediately: expiryNotificationEffects.length > 0,
      branch_taken: expiryNotificationEffects.length > 0
        ? 'expiry_notification_intent_executed_or_queued'
        : 'no_expiry_notification_intent_for_transition',
      deny_reason: expiryNotificationEffects.length > 0
        ? null
        : 'expiry_notification_effect_not_created',
    },
  });

  return finalizedBooking;
}

export async function rescheduleBooking(
  booking: Booking,
  input: RescheduleInput,
  ctx: BookingContext,
  options: { source?: 'PUBLIC_UI' | 'ADMIN_UI'; bypassPolicyWindow?: boolean } = {},
): Promise<BookingActionResult> {
  const source = options.source ?? 'PUBLIC_UI';
  const bookingPolicy = await loadBookingPolicy(ctx);
  const policy = evaluateManageBookingPolicy(booking.starts_at, bookingPolicy.selfServiceLockWindowHours);
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'reschedule_booking_policy_gate_decision',
    message: 'Evaluated reschedule booking policy gate',
    context: {
      booking_id: booking.id,
      booking_status: booking.current_status,
      starts_at: booking.starts_at,
      source,
      bypass_policy_window: Boolean(options.bypassPolicyWindow),
      can_self_serve_change: policy.canSelfServeChange,
      hours_before_start: policy.hoursBeforeStart,
      branch_taken: (!options.bypassPolicyWindow && !policy.canSelfServeChange) ? 'deny_policy_locked' : 'allow_policy_gate',
      deny_reason: (!options.bypassPolicyWindow && !policy.canSelfServeChange) ? 'starts_within_24h' : null,
    },
  });
  if (!options.bypassPolicyWindow && !policy.canSelfServeChange) {
    return {
      ok: false,
      code: 'BOOKING_POLICY_LOCKED',
      message: 'This session starts in less than 24 hours and cannot be changed online.',
      booking,
    };
  }

  const reschedulableStatuses: BookingCurrentStatus[] = ['PENDING', 'CONFIRMED'];
  if (booking.event_id) {
    return {
      ok: false,
      code: 'EVENT_BOOKING_NOT_RESCHEDULABLE',
      message: 'Only 1:1 bookings can be rescheduled',
      booking,
    };
  }

  if (isTerminalStatus(booking.current_status)) {
    return {
      ok: false,
      code: 'INVALID_STATUS',
      message: 'Booking cannot be rescheduled in its current state',
      booking,
    };
  }
  if (!reschedulableStatuses.includes(booking.current_status)) {
    return {
      ok: false,
      code: 'INVALID_STATUS',
      message: 'Booking cannot be rescheduled in its current state',
      booking,
    };
  }

  await assertSlotAvailable(input.newStart, input.newEnd, ctx.providers, {
    ignoreInterval: { start: booking.starts_at, end: booking.ends_at },
  });
  if (booking.session_type_id) {
    const sessionType = await ctx.providers.repository.getSessionTypeById(booking.session_type_id);
    if (sessionType) {
      await assertSessionTypeWeekCapacityAvailable(
        ctx.providers.repository,
        sessionType,
        input.newStart,
        sessionType.availability_timezone?.trim() || input.timezone || ctx.env.TIMEZONE,
        ctx.logger,
        { excludeBookingId: booking.id },
      );
    }
  }

  const updated = await ctx.providers.repository.updateBooking(booking.id, {
    starts_at: input.newStart,
    ends_at: input.newEnd,
    timezone: input.timezone,
  });

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    'BOOKING_RESCHEDULED',
    source,
    {
      from: { start: booking.starts_at, end: booking.ends_at, timezone: booking.timezone },
      to: { start: updated.starts_at, end: updated.ends_at, timezone: updated.timezone },
    },
    ctx,
  );

  const finalBooking = await applyImmediateNonCronSideEffectsForTransition({
    transitionEventType: 'BOOKING_RESCHEDULED',
    sourceOperation: 'reschedule_booking',
    bookingBeforeTransition: updated,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, ctx);
  return {
    ok: true,
    code: 'RESCHEDULED',
    message: 'Booking rescheduled.',
    booking: finalBooking,
  };
}

export async function retryCalendarSyncForBooking(
  booking: Booking,
  operation: 'create' | 'update' | 'delete',
  ctx: BookingContext,
): Promise<CalendarSyncResult> {
  const forceUpdate = operation === 'update';
  return syncSessionBookingCalendar(booking, ctx, {
    operation: 'calendar_retry',
    forceUpdate,
  });
}

async function retryCalendarSyncForConfirmedBookingIfMissing(
  booking: Booking,
  ctx: BookingContext,
): Promise<Booking> {
  const shouldRetry = isSessionCalendarSyncPendingRetry(booking);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_email_confirmation_repeat_sync_decision',
    message: 'Evaluated repeat confirmation calendar recovery path',
    context: {
      booking_id: booking.id,
      booking_status: booking.current_status,
      has_google_event_id: Boolean(booking.google_event_id),
      should_retry_calendar_sync: shouldRetry,
      branch_taken: shouldRetry
        ? 'retry_confirmed_booking_calendar_sync'
        : 'return_confirmed_booking_without_retry',
      deny_reason: shouldRetry ? null : 'calendar_sync_not_pending_retry',
    },
  });

  if (!shouldRetry) {
    return booking;
  }

  const syncResult = await retryCalendarSyncForBooking(booking, 'create', ctx);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_email_confirmation_repeat_sync_outcome',
    message: 'Completed repeat confirmation calendar recovery attempt',
    context: {
      booking_id: syncResult.booking.id,
      booking_status: syncResult.booking.current_status,
      has_google_event_id_after_retry: Boolean(syncResult.booking.google_event_id),
      calendar_synced: syncResult.calendarSynced,
      branch_taken: syncResult.calendarSynced
        ? 'repeat_confirmation_calendar_sync_succeeded'
        : 'repeat_confirmation_calendar_sync_failed',
      deny_reason: syncResult.calendarSynced
        ? null
        : (syncResult.failureReason ?? 'calendar_sync_failed'),
    },
  });

  return syncResult.booking;
}

async function completePendingEmailVerificationEffects(
  bookingEventId: string,
  booking: Booking,
  ctx: BookingContext,
): Promise<{
  bookingAfterVerification: Booking;
  downstreamSideEffects: BookingSideEffect[];
}> {
  const sideEffects = await ctx.providers.repository.listBookingSideEffectsForEvent(bookingEventId);
  const pendingVerificationEffects = sideEffects.filter((effect) =>
    effect.effect_intent === 'VERIFY_EMAIL_CONFIRMATION' && effect.status !== 'SUCCESS',
  );
  const existingDownstreamSideEffects = sideEffects.filter((effect) =>
    effect.effect_intent === 'RESERVE_CALENDAR_SLOT' || effect.effect_intent === 'SEND_BOOKING_CONFIRMATION',
  );
  const desiredDownstreamIntents: BookingEffectIntent[] = booking.event_id
    ? ['SEND_BOOKING_CONFIRMATION']
    : ['RESERVE_CALENDAR_SLOT', 'SEND_BOOKING_CONFIRMATION'];
  const policy = await loadBookingPolicy(ctx);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_email_confirmation_verification_effects_decision',
    message: 'Evaluated pending email-verification side effects during confirmation',
    context: {
      booking_id: booking.id,
      booking_event_id: bookingEventId,
      verification_side_effect_ids: pendingVerificationEffects.map((effect) => effect.id),
      verification_side_effect_statuses_before: pendingVerificationEffects.map((effect) => effect.status),
      existing_downstream_side_effect_ids: existingDownstreamSideEffects.map((effect) => effect.id),
      existing_downstream_side_effect_intents: existingDownstreamSideEffects.map((effect) => effect.effect_intent),
      desired_downstream_side_effect_intents: desiredDownstreamIntents,
      should_mark_verification_effects_success: pendingVerificationEffects.length > 0,
      branch_taken: pendingVerificationEffects.length > 0
        ? 'mark_pending_email_verification_effects_success'
        : 'no_pending_email_verification_effects_to_complete',
      deny_reason: pendingVerificationEffects.length > 0 ? null : 'email_verification_effect_already_completed_or_missing',
    },
  });

  let bookingAfterVerification = booking;
  if (booking.current_status === 'PENDING') {
    bookingAfterVerification = await ctx.providers.repository.updateBooking(booking.id, { current_status: 'CONFIRMED' });
  }

  if (pendingVerificationEffects.length > 0) {
    await recordSideEffectAttempts(pendingVerificationEffects, {
      status: 'SUCCESS',
      errorMessage: null,
      apiLogId: consumeLatestProviderApiLogId(ctx.operation),
      ctx,
      bookingId: booking.id,
      logSource: 'backend',
    });
  }

  const existingIntentSet = new Set(existingDownstreamSideEffects.map((effect) => effect.effect_intent));
  const missingDownstreamIntents = desiredDownstreamIntents.filter((intent) => !existingIntentSet.has(intent));
  const createdDownstreamSideEffects = missingDownstreamIntents.length > 0
    ? await ctx.providers.repository.createBookingSideEffects(
      missingDownstreamIntents.map((intent) => ({
        booking_event_id: bookingEventId,
        entity: inferEntityFromIntent(intent),
        effect_intent: intent,
        status: 'PENDING',
        expires_at: null,
        max_attempts: maxAttemptsForEffectIntent(intent, policy.processingMaxAttempts),
      })),
    )
    : [];

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_email_confirmation_downstream_side_effects_decision',
    message: 'Evaluated downstream side effects after successful email confirmation verification',
    context: {
      booking_id: booking.id,
      booking_event_id: bookingEventId,
      booking_status_after_verification: bookingAfterVerification.current_status,
      created_downstream_side_effect_ids: createdDownstreamSideEffects.map((effect) => effect.id),
      created_downstream_side_effect_intents: createdDownstreamSideEffects.map((effect) => effect.effect_intent),
      reused_downstream_side_effect_ids: existingDownstreamSideEffects.map((effect) => effect.id),
      reused_downstream_side_effect_intents: existingDownstreamSideEffects.map((effect) => effect.effect_intent),
      branch_taken: createdDownstreamSideEffects.length > 0
        ? 'create_missing_downstream_side_effects_after_verification'
        : 'reuse_existing_downstream_side_effects_after_verification',
      deny_reason: createdDownstreamSideEffects.length > 0 ? null : 'downstream_side_effects_already_exist',
    },
  });

  return {
    bookingAfterVerification,
    downstreamSideEffects: [...existingDownstreamSideEffects, ...createdDownstreamSideEffects],
  };
}

export async function sendPendingBookingFollowup(booking: Booking, ctx: BookingContext): Promise<void> {
  if (booking.current_status !== 'PENDING') return;

  const events = await ctx.providers.repository.listBookingEvents(booking.id);
  const latestSubmitted = [...events]
    .reverse()
    .find((event) => event.event_type === 'BOOKING_FORM_SUBMITTED');

  const confirmToken = typeof latestSubmitted?.payload?.['confirm_token'] === 'string'
    ? latestSubmitted.payload['confirm_token'] as string
    : null;

  if (!confirmToken) return;

  const confirmUrl = buildConfirmUrl(bookingSiteUrl(ctx), confirmToken);
  await sendEmailConfirmation(booking, confirmUrl, ctx);
}

export async function send24hBookingReminder(booking: Booking, ctx: BookingContext): Promise<void> {
  const manageUrl = await buildManageUrl(bookingSiteUrl(ctx), booking);

  if (!booking.event_id) {
    await ctx.providers.email.sendBookingReminder24h(booking, manageUrl);
  } else {
    const event = await ctx.providers.repository.getEventById(booking.event_id);
    if (!event) return;
    await ctx.providers.email.sendEventReminder24h(booking, event, manageUrl);
  }

}

export async function sendBookingCancellationConfirmation(booking: Booking, ctx: BookingContext): Promise<void> {
  const bookingKind: 'session' | 'event' = booking.event_id ? 'event' : 'session';
  const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const refundNoticeDecision = await evaluateCancellationRefundNoticeDecision(booking, payment, ctx);
  const includeRefundNotice = refundNoticeDecision.includeRefundNotice;

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_cancellation_email_dispatch_decision',
    message: 'Evaluated booking cancellation email dispatch',
    context: {
      booking_id: booking.id,
      booking_kind: bookingKind,
      booking_status: booking.current_status,
      event_id: booking.event_id ?? null,
      include_refund_notice: includeRefundNotice,
      refund_branch_taken: refundNoticeDecision.branchTaken,
      branch_taken: booking.event_id
        ? 'load_event_and_send_event_cancellation_email'
        : 'send_session_cancellation_email',
      deny_reason: null,
    },
  });

  if (!booking.event_id) {
    await ctx.providers.email.sendBookingCancellation(
      booking,
      buildStartNewBookingUrl(bookingSiteUrl(ctx), booking),
      { includeRefundNotice },
    );
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'booking_cancellation_email_dispatch_completed',
      message: 'Session cancellation email sent',
      context: {
        booking_id: booking.id,
        booking_kind: bookingKind,
        booking_status: booking.current_status,
        branch_taken: 'session_cancellation_email_sent',
        deny_reason: null,
      },
    });
    return;
  }

  const event = await ctx.providers.repository.getEventById(booking.event_id);
  if (!event) {
    ctx.logger.logError?.({
      source: 'backend',
      eventType: 'booking_cancellation_email_dispatch_failed',
      message: 'Event cancellation email denied because event record is missing',
      context: {
        booking_id: booking.id,
        booking_kind: bookingKind,
        booking_status: booking.current_status,
        event_id: booking.event_id,
        branch_taken: 'deny_event_cancellation_event_missing',
        deny_reason: 'event_not_found_for_cancellation_email',
      },
    });
    throw new Error('event_not_found_for_cancellation_email');
  }

  await ctx.providers.email.sendEventCancellation(
    booking,
    event,
    buildStartNewBookingUrl(bookingSiteUrl(ctx), booking),
    { includeRefundNotice },
  );
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_cancellation_email_dispatch_completed',
    message: 'Event cancellation email sent',
    context: {
      booking_id: booking.id,
      booking_kind: bookingKind,
      booking_status: booking.current_status,
      event_id: event.id,
      branch_taken: 'event_cancellation_email_sent',
      deny_reason: null,
    },
  });
}

export async function sendBookingFinalConfirmation(booking: Booking, ctx: BookingContext): Promise<void> {
  const policy = await loadBookingPolicy(ctx);
  const siteUrl = bookingSiteUrl(ctx);
  const manageUrl = await buildManageUrl(siteUrl, booking);
  const paymentMode = await inferPaymentModeForBooking(booking.id, ctx.providers.repository);
  let payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const bookingKind: 'session' | 'event' = booking.event_id ? 'event' : 'session';

  if (paymentMode === 'pay_later' && payment && !isPaymentSettledStatus(payment.status)) {
    const shouldBootstrapCheckoutLink = isPaymentContinuableOnline(payment.status) && !payment.checkout_url;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'booking_confirmation_payment_link_bootstrap_decision',
      message: 'Evaluated pay-later checkout link readiness for confirmation email',
      context: {
        booking_id: booking.id,
        booking_kind: bookingKind,
        booking_status: booking.current_status,
        payment_id: payment.id,
        payment_status: payment.status,
        has_invoice_url: Boolean(payment.invoice_url),
        has_checkout_url: Boolean(payment.checkout_url),
        should_bootstrap_checkout_link: shouldBootstrapCheckoutLink,
        branch_taken: shouldBootstrapCheckoutLink
          ? 'bootstrap_checkout_link_before_confirmation_email'
          : 'reuse_existing_payment_links_for_confirmation_email',
        deny_reason: shouldBootstrapCheckoutLink ? null : 'checkout_link_not_required',
      },
    });

    if (shouldBootstrapCheckoutLink) {
      try {
        const bootstrappedPayment = await ensureContinuePaymentUrlForBooking(booking, payment, ctx);
        if (bootstrappedPayment) {
          payment = bootstrappedPayment;
        }
      } catch (error) {
        ctx.logger.logWarn?.({
          source: 'backend',
          eventType: 'booking_confirmation_payment_link_bootstrap_failed',
          message: 'Proceeding with confirmation email after checkout link bootstrap failure',
          context: {
            booking_id: booking.id,
            booking_kind: bookingKind,
            booking_status: booking.current_status,
            payment_id: payment.id,
            payment_status: payment.status,
            has_invoice_url: Boolean(payment.invoice_url),
            has_checkout_url: Boolean(payment.checkout_url),
            branch_taken: 'continue_with_fallback_payment_link',
            deny_reason: 'checkout_link_bootstrap_failed',
            failure_reason: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  const isPayLaterPendingConfirmation = paymentMode === 'pay_later' && !isPaymentSettledStatus(payment?.status ?? null);
  const paymentSettledForEmail = isPaymentSettledStatus(payment?.status ?? null);
  const paymentEmailLinks = paymentMode === 'pay_later'
    ? paymentEmailUrl({ booking, payment, siteUrl })
    : { invoiceUrl: payment?.invoice_url ?? null, payUrl: null };
  const payUrl = paymentEmailLinks.payUrl;
  const invoiceUrl = paymentEmailLinks.invoiceUrl;
  const receiptUrl = paymentSettledForEmail ? payment?.stripe_receipt_url ?? null : null;
  const paymentDueAt = isPayLaterPendingConfirmation
    ? getPaymentDueAtIso(booking.starts_at, policy.paymentDueBeforeStartHours)
    : null;

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_confirmation_email_dispatch_decision',
    message: 'Evaluated final booking confirmation email dispatch eligibility',
    context: {
      booking_id: booking.id,
      booking_kind: bookingKind,
      booking_status: booking.current_status,
      payment_mode: paymentMode,
      payment_status: payment?.status ?? null,
      has_google_event_id: Boolean(booking.google_event_id),
      has_manage_url: Boolean(manageUrl),
      has_invoice_url: Boolean(invoiceUrl),
      has_receipt_url: Boolean(receiptUrl),
      has_pay_url: Boolean(payUrl),
      calendar_sync_pending_retry: !booking.event_id && !booking.google_event_id,
      email_variant: isPayLaterPendingConfirmation ? 'confirmed_payment_pending' : 'confirmed_paid_or_free',
      branch_taken: isPayLaterPendingConfirmation
        ? 'allow_pay_later_confirmation_email'
        : !booking.event_id && !booking.google_event_id
        ? 'allow_session_confirmation_email_while_calendar_sync_pending_retry'
        : 'allow_confirmation_email_dispatch',
      deny_reason: isPayLaterPendingConfirmation
        ? null
        : !booking.event_id && !booking.google_event_id
        ? 'session_calendar_invite_missing_but_confirmation_still_allowed'
        : null,
    },
  });

  if (!booking.event_id) {
    if (!isPayLaterPendingConfirmation && !booking.google_event_id) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'booking_confirmation_email_dispatch_degraded',
        message: 'Sending session confirmation email while calendar sync remains pending retry',
        context: {
          booking_id: booking.id,
          booking_kind: bookingKind,
          booking_status: booking.current_status,
          payment_mode: paymentMode,
          payment_status: payment?.status ?? null,
          has_google_event_id: false,
          has_meeting_link: Boolean(booking.meeting_link),
          has_manage_url: Boolean(manageUrl),
          branch_taken: 'send_confirmation_without_calendar_invite',
          deny_reason: 'calendar_sync_pending_retry',
        },
      });
    }
    await ctx.providers.email.sendBookingConfirmation(
      booking,
      manageUrl,
      invoiceUrl,
      payUrl,
      getBookingPolicyText(policy.selfServiceLockWindowHours),
      {
        paymentSettled: paymentSettledForEmail,
        paymentDueAt,
        receiptUrl,
      },
    );
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'booking_confirmation_email_dispatch_completed',
      message: 'Session confirmation email sent',
      context: {
        booking_id: booking.id,
        booking_kind: bookingKind,
        booking_status: booking.current_status,
        payment_mode: paymentMode,
        payment_status: payment?.status ?? null,
        email_variant: isPayLaterPendingConfirmation ? 'confirmed_payment_pending' : 'confirmed_paid_or_free',
        branch_taken: isPayLaterPendingConfirmation
          ? 'session_pay_later_confirmation_email_sent'
          : 'session_confirmation_email_sent',
        deny_reason: null,
      },
    });
    return;
  }

  const event = await ctx.providers.repository.getEventById(booking.event_id);
  if (!event) {
    ctx.logger.logError?.({
      source: 'backend',
      eventType: 'booking_confirmation_email_dispatch_failed',
      message: 'Event confirmation email denied because event record is missing',
      context: {
        booking_id: booking.id,
        booking_kind: bookingKind,
        booking_status: booking.current_status,
        event_id: booking.event_id,
        branch_taken: 'deny_event_confirmation_event_missing',
        deny_reason: 'event_not_found_for_confirmation_email',
      },
    });
    throw new Error('event_not_found_for_confirmation_email');
  }
  await ctx.providers.email.sendEventConfirmation(
    booking,
    event,
    manageUrl,
    invoiceUrl,
    payUrl,
    getBookingPolicyText(policy.selfServiceLockWindowHours),
    {
      paymentSettled: paymentSettledForEmail,
      paymentDueAt,
      receiptUrl,
    },
  );
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_confirmation_email_dispatch_completed',
    message: 'Event confirmation email sent',
    context: {
      booking_id: booking.id,
      booking_kind: bookingKind,
      booking_status: booking.current_status,
      event_id: event.id,
      payment_status: payment?.status ?? null,
      email_variant: isPayLaterPendingConfirmation ? 'confirmed_payment_pending' : 'confirmed_paid_or_free',
      branch_taken: isPayLaterPendingConfirmation
        ? 'event_pay_later_confirmation_email_sent'
        : 'event_confirmation_email_sent',
      deny_reason: null,
    },
  });
}

export async function getBookingPublicActionInfo(
  booking: Booking,
  ctx: BookingContext,
): Promise<BookingPublicActionInfo> {
  const event = booking.event_id
    ? await ctx.providers.repository.getEventById(booking.event_id)
    : null;
  const manageUrl = isTerminalStatus(booking.current_status)
    ? null
    : await buildManageUrl(bookingSiteUrl(ctx), booking);

  const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const checkoutUrl = payment && canContinuePayLaterPayment(booking, payment.status)
    ? buildContinuePaymentUrl(bookingSiteUrl(ctx), booking)
    : payment
      && !isTerminalStatus(booking.current_status)
      && booking.booking_type !== 'PAY_LATER'
      && isPaymentContinuableOnline(payment.status)
      && Boolean(paymentProviderUrl(payment))
      ? buildContinuePaymentUrl(bookingSiteUrl(ctx), booking)
      : null;

  if (checkoutUrl) {
    return {
      booking,
      checkoutUrl,
      manageUrl,
      nextActionUrl: checkoutUrl,
      nextActionLabel: 'Complete Payment',
      calendarEvent: buildPublicCalendarEventInfo(booking, event),
      calendarSyncPendingRetry: isSessionCalendarSyncPendingRetry(booking),
    };
  }

  return {
    booking,
    checkoutUrl,
    manageUrl,
    nextActionUrl: manageUrl,
    nextActionLabel: manageUrl ? 'Manage Booking' : null,
    calendarEvent: buildPublicCalendarEventInfo(booking, event),
    calendarSyncPendingRetry: isSessionCalendarSyncPendingRetry(booking),
  };
}

export function evaluateManageBookingPolicy(startsAtIso: string, selfServiceLockWindowHours: number): {
  canSelfServeChange: boolean;
  hoursBeforeStart: number;
  policyText: string;
} {
  const nowMs = Date.now();
  const startsAtMs = new Date(startsAtIso).getTime();
  const hoursBeforeStart = (startsAtMs - nowMs) / 3_600_000;
  return {
    canSelfServeChange: hoursBeforeStart >= selfServiceLockWindowHours,
    hoursBeforeStart,
    policyText: getBookingPolicyText(selfServiceLockWindowHours),
  };
}

export async function getBookingPublicActionInfoByPaymentSession(
  sessionId: string,
  ctx: BookingContext,
): Promise<BookingPublicActionInfo> {
  const payment = await ctx.providers.repository.getPaymentByStripeCheckoutSessionId(sessionId);
  if (!payment) throw notFound('Payment session not found');

  const booking = await ctx.providers.repository.getBookingById(payment.booking_id);
  if (!booking) throw notFound('Booking not found');

  return getBookingPublicActionInfo(booking, ctx);
}

export async function getContinuePaymentActionInfo(
  rawToken: string,
  rawAdminToken: string | null,
  ctx: BookingContext,
): Promise<ContinuePaymentActionInfo> {
  const access = await resolveBookingManageAccess(rawToken, rawAdminToken, ctx);
  const booking = access.booking;
  const policy = await loadBookingPolicy(ctx);
  const paymentDueAt = getPaymentDueAtIso(booking.starts_at, policy.paymentDueBeforeStartHours);
  const manageUrl = await buildManageUrl(bookingSiteUrl(ctx), booking);
  let payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  let branchTaken = 'allow_continue_payment_redirect';
  let denyReason: string | null = null;
  if (booking.booking_type !== 'PAY_LATER') {
    branchTaken = 'deny_continue_payment_booking_not_pay_later';
    denyReason = 'booking_not_pay_later';
  } else if (!payment) {
    branchTaken = 'deny_continue_payment_payment_missing';
    denyReason = 'payment_missing';
  } else if (booking.current_status !== 'CONFIRMED') {
    branchTaken = 'deny_continue_payment_booking_not_confirmed';
    denyReason = 'booking_not_confirmed';
  } else if (!isPaymentContinuableOnline(payment.status)) {
    branchTaken = 'deny_continue_payment_payment_not_continuable';
    denyReason = 'payment_status_not_continuable_online';
  }

  if (!denyReason && payment && !paymentCheckoutUrlForContinuation(payment)) {
    const bootstrappedPayment = await ensureContinuePaymentUrlForBooking(booking, payment, ctx);
    payment = bootstrappedPayment ?? payment;
    if (!paymentCheckoutUrlForContinuation(payment)) {
      branchTaken = 'deny_continue_payment_checkout_url_missing_after_bootstrap';
      denyReason = 'checkout_url_missing_after_bootstrap';
    } else {
      branchTaken = 'allow_continue_payment_redirect_after_bootstrap';
    }
  }

  const continuationUrl = denyReason ? null : paymentCheckoutUrlForContinuation(payment);
  const canContinueToCheckout = !denyReason && Boolean(continuationUrl);

  return {
    booking,
    paymentStatus: payment?.status ?? null,
    paymentDueAt,
    manageUrl,
    checkoutUrl: canContinueToCheckout ? continuationUrl : null,
    canContinueToCheckout,
    branchTaken,
    denyReason,
  };
}

export async function ensureEventPublicBookable(
  event: Event,
  repository: Pick<BookingContext['providers']['repository'], 'listSystemSettings'>,
): Promise<void> {
  const policy = await getBookingPolicyConfig(repository);
  const normalizedEvent = normalizeEventRow(event);
  if (!isEventPublished(normalizedEvent.status)) throw badRequest('Event is not open for booking');
  const nowMs = Date.now();
  const cutoffMs = new Date(normalizedEvent.starts_at).getTime()
    + policy.publicEventCutoffAfterStartMinutes * 60_000;
  if (nowMs > cutoffMs) {
    throw gone('Public event registration is closed');
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function upsertClient(
  input: { firstName: string; lastName: string | null; email: string; phone: string | null },
  providers: Providers,
) {
  const existing = await providers.repository.getClientByEmail(input.email);
  if (existing) {
    return providers.repository.updateClient(existing.id, {
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      phone: input.phone ?? existing.phone,
    });
  }

  return providers.repository.createClient({
    first_name: input.firstName,
    last_name: input.lastName,
    email: input.email,
    phone: input.phone,
  });
}

async function ensureEventCapacity(event: Event, providers: Providers): Promise<void> {
  const active = await providers.repository.countEventActiveBookings(event.id, new Date().toISOString());
  if (active >= event.capacity) {
    throw conflict('Event is at capacity');
  }
}

async function assertSlotAvailable(
  start: string,
  end: string,
  providers: Providers,
  options?: { ignoreInterval?: { start: string; end: string } },
): Promise<void> {
  const from = start.slice(0, 10);
  const to = end.slice(0, 10);

  const [busyTimes, heldSlots] = await Promise.all([
    providers.calendar.getBusyTimes(from, to),
    providers.repository.getHeldSlots(from, to),
  ]);

  const allBusy = [...busyTimes, ...heldSlots];
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const ignoreStartMs = options?.ignoreInterval ? new Date(options.ignoreInterval.start).getTime() : null;
  const ignoreEndMs = options?.ignoreInterval ? new Date(options.ignoreInterval.end).getTime() : null;

  for (const busy of allBusy) {
    const busyStartMs = new Date(busy.start).getTime();
    const busyEndMs = new Date(busy.end).getTime();
    if (ignoreStartMs !== null && ignoreEndMs !== null && busyStartMs === ignoreStartMs && busyEndMs === ignoreEndMs) {
      continue;
    }
    if (startMs < busyEndMs && endMs > busyStartMs) {
      throw conflict('This slot is no longer available');
    }
  }
}

function splitFullName(name: string): { firstName: string; lastName: string | null } {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { firstName: 'Unknown', lastName: null };
  const [first, ...rest] = trimmed.split(' ');
  return {
    firstName: first || 'Unknown',
    lastName: rest.length ? rest.join(' ') : null,
  };
}

export function buildConfirmUrl(siteUrl: string, rawToken: string): string {
  return `${siteUrl}/confirm.html?token=${encodeURIComponent(rawToken)}`;
}

export async function buildManageUrl(siteUrl: string, booking: Booking): Promise<string> {
  const token = buildStableManageToken(booking.id);
  return `${siteUrl}/manage.html?token=${encodeURIComponent(token)}`;
}

export function buildPublicCalendarEventInfo(
  booking: Pick<Booking, 'current_status' | 'event_id' | 'starts_at' | 'ends_at' | 'timezone' | 'address_line' | 'meeting_link' | 'session_type_title'>,
  event: Pick<Event, 'title' | 'starts_at' | 'ends_at'> | null,
): PublicCalendarEventInfo | null {
  if (booking.current_status !== 'CONFIRMED' && booking.current_status !== 'COMPLETED') {
    return null;
  }

  if (booking.event_id) {
    const eventTitle = event?.title?.trim() || 'ILLUMINATE Evening';
    const eventDescription = [
      'ILLUMINATE Evening with Yair Benharroch.',
      booking.meeting_link ? `Google Meet: ${booking.meeting_link}` : null,
    ].filter((line): line is string => Boolean(line)).join('\n');
    return {
      title: `${eventTitle} — ILLUMINATE Evening`,
      start: event?.starts_at ?? booking.starts_at,
      end: event?.ends_at ?? booking.ends_at,
      timezone: booking.timezone,
      location: booking.address_line || '',
      description: eventDescription,
    };
  }

  const sessionDescription = [
    '1:1 Clarity Session with Yair Benharroch.',
    booking.meeting_link ? `Google Meet: ${booking.meeting_link}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n');
  return {
    title: booking.session_type_title?.trim() || 'Clarity Session',
    start: booking.starts_at,
    end: booking.ends_at,
    timezone: booking.timezone,
    location: booking.address_line || '',
    description: sessionDescription,
  };
}

export function isSessionCalendarSyncPendingRetry(
  booking: Pick<Booking, 'current_status' | 'event_id' | 'google_event_id'>,
): boolean {
  return !booking.event_id
    && !booking.google_event_id
    && (booking.current_status === 'CONFIRMED' || booking.current_status === 'COMPLETED');
}

export function buildContinuePaymentUrl(siteUrl: string, booking: Booking): string {
  const token = buildStableManageToken(booking.id);
  return `${siteUrl}/continue-payment.html?token=${encodeURIComponent(token)}`;
}

function buildStableManageToken(bookingId: string): string {
  return `m1.${bookingId}`;
}

function buildStartNewBookingUrl(siteUrl: string, booking: Booking): string {
  const base = siteUrl.replace(/\/+$/g, '');
  return booking.event_id ? `${base}/evenings.html` : `${base}/sessions.html`;
}

function parseStableManageToken(rawToken: string): { bookingId: string } | null {
  const parts = rawToken.split('.');
  if (parts.length === 2 && parts[0] === 'm1' && parts[1]) {
    return { bookingId: parts[1] };
  }
  if (parts.length === 3 && parts[0] === 'm1' && parts[1]) {
    // Backward compatibility with old signed shape: m1.<bookingId>.<signature>
    return { bookingId: parts[1] };
  }
  return null;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function sendEmailConfirmation(booking: Booking, confirmUrl: string, ctx: BookingContext): Promise<void> {
  const policy = await loadBookingPolicy(ctx);
  if (!booking.event_id) {
    await ctx.providers.email.sendBookingConfirmRequest(booking, confirmUrl, policy.nonPaidConfirmationWindowMinutes);
    return;
  }

  const event = await ctx.providers.repository.getEventById(booking.event_id);
  if (!event) return;
  await ctx.providers.email.sendEventConfirmRequest(
    booking,
    event,
    confirmUrl,
    policy.nonPaidConfirmationWindowMinutes,
  );
}

function getPaymentDueAtIso(startsAtIso: string, paymentDueBeforeStartHours: number): string {
  return new Date(
    new Date(startsAtIso).getTime() - paymentDueBeforeStartHours * 60 * 60 * 1000,
  ).toISOString();
}

async function schedulePayLaterPaymentFollowups(
  booking: Booking,
  bookingEventId: string,
  ctx: BookingContext,
): Promise<void> {
  const policy = await loadBookingPolicy(ctx);
  const paymentDueAt = getPaymentDueAtIso(booking.starts_at, policy.paymentDueBeforeStartHours);
  const reminderAt = computePaymentDueReminderTime(
    new Date(paymentDueAt),
    booking.timezone,
    policy,
    new Date(),
  );
  const shouldScheduleReminder = reminderAt.getTime() < new Date(paymentDueAt).getTime();

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'pay_later_followup_side_effects_decision',
    message: 'Evaluated pay-later reminder and expiry follow-up scheduling',
    context: {
      booking_id: booking.id,
      booking_event_id: bookingEventId,
      payment_due_at: paymentDueAt,
      computed_payment_reminder_at: reminderAt.toISOString(),
      should_schedule_payment_reminder: shouldScheduleReminder,
      payment_due_before_start_hours: policy.paymentDueBeforeStartHours,
      payment_reminder_lead_hours: policy.paymentDueReminderLeadHours,
      branch_taken: shouldScheduleReminder
        ? 'schedule_payment_reminder_and_due_verification'
        : 'schedule_due_verification_only',
      deny_reason: shouldScheduleReminder ? null : 'payment_reminder_would_run_at_or_after_due_time',
    },
  });

  const effects = [
    shouldScheduleReminder
      ? {
          booking_event_id: bookingEventId,
          entity: inferEntityFromIntent('SEND_PAYMENT_REMINDER'),
          effect_intent: 'SEND_PAYMENT_REMINDER' as const,
          status: 'PENDING' as const,
          expires_at: reminderAt.toISOString(),
          max_attempts: policy.processingMaxAttempts,
        }
      : null,
    {
      booking_event_id: bookingEventId,
      entity: inferEntityFromIntent('VERIFY_STRIPE_PAYMENT'),
      effect_intent: 'VERIFY_STRIPE_PAYMENT' as const,
      status: 'PENDING' as const,
          expires_at: paymentDueAt,
          max_attempts: policy.processingMaxAttempts,
        },
  ].filter((effect): effect is {
    booking_event_id: string;
    entity: ReturnType<typeof inferEntityFromIntent>;
    effect_intent: 'SEND_PAYMENT_REMINDER' | 'VERIFY_STRIPE_PAYMENT';
    status: 'PENDING';
    expires_at: string;
    max_attempts: number;
  } => effect !== null);

  const created = await ctx.providers.repository.createBookingSideEffects(effects);
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'pay_later_followup_side_effects_scheduled',
    message: 'Scheduled pay-later reminder and due verification side effects',
    context: {
      booking_id: booking.id,
      booking_event_id: bookingEventId,
      payment_due_at: paymentDueAt,
      created_side_effect_ids: created.map((effect) => effect.id),
      created_side_effect_intents: created.map((effect) => effect.effect_intent),
      branch_taken: 'pay_later_followups_scheduled',
    },
  });
}

function shouldSessionBookingHaveCalendarEvent(booking: Booking): boolean {
  if (booking.event_id) return false;
  return booking.current_status === 'CONFIRMED';
}

function fullClientName(booking: Booking): string {
  return [booking.client_first_name ?? '', booking.client_last_name ?? ''].join(' ').trim() || 'Unknown Client';
}

function sessionCalendarTitle(booking: Pick<Booking, 'session_type_title'>): string {
  return booking.session_type_title?.trim() || '1:1 Session';
}

function buildSessionCalendarEventPayload(booking: Booking, requestId: string): CalendarEvent {
  const durationMinutes = Math.max(1, Math.round(
    (new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime()) / 60000,
  ));

  const descriptionLines = [
    sessionCalendarTitle(booking),
    `Client: ${fullClientName(booking)}`,
    `Email: ${booking.client_email ?? 'n/a'}`,
    `Phone: ${booking.client_phone ?? 'n/a'}`,
    `Booking ID: ${booking.id}`,
    `Current status: ${booking.current_status}`,
    `Duration: ${durationMinutes} minutes`,
    `Timezone: ${booking.timezone}`,
    booking.notes ? `Notes: ${booking.notes}` : null,
  ];

  return {
    title: sessionCalendarTitle(booking),
    description: descriptionLines.filter((line): line is string => Boolean(line)).join('\n'),
    startIso: booking.starts_at,
    endIso: booking.ends_at,
    timezone: booking.timezone,
    location: booking.address_line,
    attendeeEmail: booking.client_email ?? 'unknown@example.com',
    attendeeName: fullClientName(booking),
    privateMetadata: {
      booking_id: booking.id,
      request_id: requestId,
      current_status: booking.current_status,
    },
  };
}

async function syncSessionBookingCalendar(
  booking: Booking,
  ctx: BookingContext,
  options: { operation: string; forceUpdate?: boolean },
): Promise<CalendarSyncResult> {
  const { providers, logger } = ctx;

  if (booking.event_id) {
    return {
      booking,
      calendarSynced: true,
      failureReason: null,
      retryableFailure: false,
      retryableFailureReason: null,
    };
  }

  const needsEvent = shouldSessionBookingHaveCalendarEvent(booking);
  const payload = buildSessionCalendarEventPayload(booking, ctx.requestId);

  if (!needsEvent) {
    if (!booking.google_event_id) {
      return {
        booking,
        calendarSynced: true,
        failureReason: null,
        retryableFailure: false,
        retryableFailureReason: null,
      };
    }

    try {
      await providers.calendar.deleteEvent(booking.google_event_id);
      const updated = await providers.repository.updateBooking(booking.id, {
        google_event_id: null,
        meeting_provider: null,
        meeting_link: null,
      });
      return {
        booking: updated,
        calendarSynced: true,
        failureReason: null,
        retryableFailure: false,
        retryableFailureReason: null,
      };
    } catch (error) {
      if (isCalendarEventMissingError(error)) {
        logger.logWarn?.({
          source: 'backend',
          eventType: 'calendar_event_missing_on_cancel',
          message: 'Calendar event was missing during cancellation; proceeding with successful cancellation.',
          context: {
            booking_id: booking.id,
            operation: options.operation,
            google_event_id: booking.google_event_id,
            special_case_code: 'CALENDAR_EVENT_MISSING_ON_CANCEL',
            branch_taken: 'calendar_event_missing_treated_as_cancel_success',
            deny_reason: 'calendar_event_not_found',
          },
        });
        try {
          const updated = await providers.repository.updateBooking(booking.id, {
            google_event_id: null,
            meeting_provider: null,
            meeting_link: null,
          });
          return {
            booking: updated,
            calendarSynced: true,
            failureReason: null,
            retryableFailure: false,
            retryableFailureReason: null,
          };
        } catch (persistError) {
          logger.logError?.({
            source: 'backend',
            eventType: 'calendar_event_missing_on_cancel_persist_failed',
            message: 'Calendar event was missing on cancel, but clearing stale google_event_id failed.',
            context: {
              booking_id: booking.id,
              operation: options.operation,
              google_event_id: booking.google_event_id,
              special_case_code: 'CALENDAR_EVENT_MISSING_ON_CANCEL',
              branch_taken: 'calendar_event_missing_cancel_persist_failed',
              deny_reason: toSyncFailureReason(persistError),
            },
          });
          return {
            booking,
            calendarSynced: false,
            failureReason: toSyncFailureReason(persistError),
            retryableFailure: false,
            retryableFailureReason: null,
          };
        }
      }
      logger.error('Calendar delete failed', {
        bookingId: booking.id,
        operation: options.operation,
        googleEventId: booking.google_event_id,
        error: String(error),
      });
      return {
        booking,
        calendarSynced: false,
        failureReason: toSyncFailureReason(error),
        retryableFailure: false,
        retryableFailureReason: null,
      };
    }
  }

  if (booking.google_event_id) {
    if (!options.forceUpdate) {
      return {
        booking,
        calendarSynced: true,
        failureReason: null,
        retryableFailure: false,
        retryableFailureReason: null,
      };
    }

    try {
      const updatedEvent = await providers.calendar.updateEvent(booking.google_event_id, payload);
      const updates = buildMeetingPersistenceUpdate(booking, updatedEvent);
      if (!updates) {
        return {
          booking,
          calendarSynced: true,
          failureReason: null,
          retryableFailure: false,
          retryableFailureReason: null,
        };
      }
      const updated = await providers.repository.updateBooking(booking.id, updates);
      return {
        booking: updated,
        calendarSynced: true,
        failureReason: null,
        retryableFailure: false,
        retryableFailureReason: null,
      };
    } catch (error) {
      if (isCalendarEventMissingError(error)) {
        logger.logWarn?.({
          source: 'backend',
          eventType: 'calendar_event_missing_on_reschedule',
          message: 'Calendar event was missing during reschedule; creating a replacement event.',
          context: {
            booking_id: booking.id,
            operation: options.operation,
            google_event_id: booking.google_event_id,
            special_case_code: 'CALENDAR_EVENT_MISSING_ON_RESCHEDULE',
            branch_taken: 'calendar_event_missing_recreate_on_reschedule',
            deny_reason: 'calendar_event_not_found',
          },
        });
        try {
          const created = await providers.calendar.createEvent(payload);
          logMissingMeetLinkAfterCalendarCreate(booking, created, options.operation, logger);
          const updated = await providers.repository.updateBooking(
            booking.id,
            buildCreateCalendarPersistenceUpdate(created),
          );
          logger.logInfo?.({
            source: 'backend',
            eventType: 'calendar_event_recreated_after_missing',
            message: 'Recreated calendar event after missing event was detected during reschedule.',
            context: {
              booking_id: booking.id,
              operation: options.operation,
              previous_google_event_id: booking.google_event_id,
              replacement_google_event_id: created.eventId,
              special_case_code: 'CALENDAR_EVENT_RECREATED_AFTER_MISSING',
              branch_taken: 'calendar_event_recreated_and_booking_updated',
              deny_reason: null,
            },
          });
          return {
            booking: updated,
            calendarSynced: true,
            failureReason: null,
            retryableFailure: false,
            retryableFailureReason: null,
          };
        } catch (recreateError) {
          logger.logError?.({
            source: 'backend',
            eventType: 'calendar_event_recreate_failed_after_missing',
            message: 'Failed to recreate calendar event after missing event was detected during reschedule.',
            context: {
              booking_id: booking.id,
              operation: options.operation,
              previous_google_event_id: booking.google_event_id,
              special_case_code: 'CALENDAR_EVENT_RECREATED_AFTER_MISSING',
              branch_taken: 'calendar_event_recreate_failed_after_missing',
              deny_reason: toSyncFailureReason(recreateError),
            },
          });
          return {
            booking,
            calendarSynced: false,
            failureReason: toSyncFailureReason(recreateError),
            retryableFailure: isRetryableCalendarWriteError(recreateError),
            retryableFailureReason: isRetryableCalendarWriteError(recreateError) ? recreateError.reason : null,
          };
        }
      }
      logger.error('Calendar update failed', {
        bookingId: booking.id,
        operation: options.operation,
        googleEventId: booking.google_event_id,
        error: String(error),
      });
      return {
        booking,
        calendarSynced: false,
        failureReason: toSyncFailureReason(error),
        retryableFailure: isRetryableCalendarWriteError(error),
        retryableFailureReason: isRetryableCalendarWriteError(error) ? error.reason : null,
      };
    }
  }

  try {
    const created = await providers.calendar.createEvent(payload);
    logMissingMeetLinkAfterCalendarCreate(booking, created, options.operation, logger);
    const updated = await providers.repository.updateBooking(
      booking.id,
      buildCreateCalendarPersistenceUpdate(created),
    );
    return {
      booking: updated,
      calendarSynced: true,
      failureReason: null,
      retryableFailure: false,
      retryableFailureReason: null,
    };
  } catch (error) {
    logger.error('Calendar create failed', {
      bookingId: booking.id,
      operation: options.operation,
      error: String(error),
    });
    return {
      booking,
      calendarSynced: false,
      failureReason: toSyncFailureReason(error),
      retryableFailure: isRetryableCalendarWriteError(error),
      retryableFailureReason: isRetryableCalendarWriteError(error) ? error.reason : null,
    };
  }
}

function buildCreateCalendarPersistenceUpdate(
  created: { eventId: string; meetingProvider: 'google_meet' | null; meetingLink: string | null },
): Pick<Booking, 'google_event_id' | 'meeting_provider' | 'meeting_link'> {
  return {
    google_event_id: created.eventId,
    meeting_provider: created.meetingLink ? created.meetingProvider : null,
    meeting_link: created.meetingLink,
  };
}

function buildMeetingPersistenceUpdate(
  booking: Booking,
  updatedEvent: { eventId: string; meetingProvider: 'google_meet' | null; meetingLink: string | null },
): Pick<Booking, 'google_event_id' | 'meeting_provider' | 'meeting_link'> | null {
  if (!updatedEvent.meetingLink) {
    return updatedEvent.eventId !== booking.google_event_id
      ? {
        google_event_id: updatedEvent.eventId,
        meeting_provider: booking.meeting_provider ?? null,
        meeting_link: booking.meeting_link ?? null,
      }
      : null;
  }

  if (
    updatedEvent.eventId === booking.google_event_id
    && updatedEvent.meetingLink === (booking.meeting_link ?? null)
    && (updatedEvent.meetingProvider ?? null) === (booking.meeting_provider ?? null)
  ) {
    return null;
  }

  return {
    google_event_id: updatedEvent.eventId,
    meeting_provider: updatedEvent.meetingProvider,
    meeting_link: updatedEvent.meetingLink,
  };
}

function logMissingMeetLinkAfterCalendarCreate(
  booking: Booking,
  created: { eventId: string; meetingProvider: 'google_meet' | null; meetingLink: string | null },
  operation: string,
  logger: BookingContext['logger'],
): void {
  if (created.meetingLink) return;

  logger.logWarn?.({
    source: 'backend',
    eventType: 'calendar_meet_link_missing_after_create',
    message: 'Calendar event creation succeeded but no Google Meet link was returned.',
    context: {
      booking_id: booking.id,
      operation,
      google_event_id: created.eventId,
      branch_taken: 'calendar_event_created_without_meet_link',
      deny_reason: 'google_meet_link_missing_in_create_response',
    },
  });
}

function isCalendarEventMissingError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && error !== null) {
    const candidate = error as Record<string, unknown>;
    const status = Number(candidate['status'] ?? candidate['statusCode'] ?? candidate['httpStatus']);
    if (status === 404 || status === 410) return true;
    const code = String(candidate['code'] ?? '').toLowerCase();
    if (code === 'notfound' || code === '404' || code === '410') return true;
  }

  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  if (message.includes('not found')) return true;
  if (message.includes('status: 404') || message.includes('status 404')) return true;
  if (message.includes('status: 410') || message.includes('status 410')) return true;
  if (message.includes('failed (404)') || message.includes('failed (410)')) return true;
  if (message.includes('"code":404') || message.includes('"code":410')) return true;
  if (message.includes('"reason":"notfound"')) return true;
  return false;
}

function reservationSkipReason(
  eventType: BookingEventType,
  bookingBeforeTransition: Booking,
  bookingAfterTransition: Booking,
): string {
  if (bookingAfterTransition.event_id) return 'event_booking';
  if (bookingBeforeTransition.current_status === bookingAfterTransition.current_status) return 'no_status_transition';
  const reservableBefore = bookingBeforeTransition.current_status === 'CONFIRMED';
  const reservableAfter = bookingAfterTransition.current_status === 'CONFIRMED';
  if (!reservableAfter) return 'target_status_not_reservable';
  if (reservableBefore) return 'already_reservable_before_transition';
  return `event_not_reservation_trigger:${eventType}`;
}

function shouldRunImmediateTransitionSideEffect(intent: BookingEffectIntent): boolean {
  if (CRON_MANAGED_SIDE_EFFECT_INTENTS.has(intent)) return false;
  return REALTIME_TRANSITION_SIDE_EFFECT_INTENTS.has(intent);
}

export async function applyImmediateNonCronSideEffectsForTransition(
  input: {
    transitionEventType: BookingEventType;
    sourceOperation: string;
    bookingBeforeTransition: Booking;
    bookingAfterTransition: Booking;
    transitionSideEffects: BookingSideEffect[];
  },
  ctx: BookingContext,
): Promise<Booking> {
  const { logger } = ctx;
  const realtimeEffects = input.transitionSideEffects.filter((effect) =>
    shouldRunImmediateTransitionSideEffect(effect.effect_intent),
  );

  logger.logInfo?.({
    source: 'backend',
    eventType: 'realtime_side_effect_transition_decision',
    message: 'Evaluated immediate non-cron side effects for transition',
    context: {
      booking_id: input.bookingAfterTransition.id,
      transition_event_type: input.transitionEventType,
      source_operation: input.sourceOperation,
      current_status_before: input.bookingBeforeTransition.current_status,
      current_status_after: input.bookingAfterTransition.current_status,
      all_transition_side_effect_ids: input.transitionSideEffects.map((effect) => effect.id),
      all_transition_side_effect_intents: input.transitionSideEffects.map((effect) => effect.effect_intent),
      realtime_side_effect_ids: realtimeEffects.map((effect) => effect.id),
      realtime_side_effect_intents: realtimeEffects.map((effect) => effect.effect_intent),
      should_execute_realtime_side_effects: realtimeEffects.length > 0,
      branch_taken: realtimeEffects.length > 0
        ? 'execute_realtime_side_effects_immediately'
        : 'no_realtime_side_effects_for_transition',
      deny_reason: realtimeEffects.length > 0 ? null : 'transition_has_no_non_cron_realtime_side_effects',
    },
  });

  if (realtimeEffects.length === 0) {
    return input.bookingAfterTransition;
  }

  let currentBooking = input.bookingAfterTransition;

  for (const effect of realtimeEffects) {
    if (ctx.operation) {
      extendOperationContext(ctx.operation, {
        bookingId: currentBooking.id,
        sideEffectId: effect.id,
        sideEffectAttemptId: null,
      });
    }

    logger.logInfo?.({
      source: 'backend',
      eventType: 'realtime_side_effect_attempt_started',
      message: 'Immediate side effect attempt started',
      context: {
        booking_id: currentBooking.id,
        transition_event_type: input.transitionEventType,
        source_operation: input.sourceOperation,
        side_effect_id: effect.id,
        side_effect_intent: effect.effect_intent,
        side_effect_status_before: effect.status,
        branch_taken: `attempt_${effect.effect_intent}_immediately`,
      },
    });

    try {
      await markSideEffectsProcessing([effect], ctx);
      currentBooking = await executeImmediateTransitionSideEffect(effect, currentBooking, input, ctx);
      await recordSideEffectAttempts([effect], {
        status: 'SUCCESS',
        errorMessage: null,
        apiLogId: consumeLatestProviderApiLogId(ctx.operation),
        ctx,
        bookingId: currentBooking.id,
        logSource: 'backend',
      });

      logger.logInfo?.({
        source: 'backend',
        eventType: 'realtime_side_effect_attempt_completed',
        message: 'Immediate side effect attempt succeeded',
        context: {
          booking_id: currentBooking.id,
          transition_event_type: input.transitionEventType,
          source_operation: input.sourceOperation,
          side_effect_id: effect.id,
          side_effect_intent: effect.effect_intent,
          side_effect_status_after: 'SUCCESS',
          branch_taken: 'realtime_side_effect_succeeded',
        },
      });
    } catch (error) {
      const failureReason = toSyncFailureReason(error);
      const enableCalendarBackoff = isRetryableCalendarWriteError(error) && isCalendarWriteEffectIntent(effect.effect_intent);

      try {
        await recordSideEffectAttempts([effect], {
          status: 'FAILED',
          errorMessage: failureReason,
          apiLogId: consumeLatestProviderApiLogId(ctx.operation),
          ctx,
          bookingId: currentBooking.id,
          logSource: 'backend',
          enableCalendarBackoff,
        });
      } catch (attemptError) {
        logger.logError?.({
          source: 'backend',
          eventType: 'realtime_side_effect_attempt_record_failed',
          message: 'Failed to record failed immediate side effect attempt',
          context: {
            booking_id: currentBooking.id,
            transition_event_type: input.transitionEventType,
            source_operation: input.sourceOperation,
            side_effect_id: effect.id,
            side_effect_intent: effect.effect_intent,
            failure_reason: failureReason,
            record_failure_reason: toSyncFailureReason(attemptError),
            branch_taken: 'realtime_side_effect_failed_record_persist_error',
          },
        });
      }

      logger.logWarn?.({
        source: 'backend',
        eventType: 'realtime_side_effect_attempt_completed',
        message: 'Immediate side effect attempt failed; retry path retained',
        context: {
          booking_id: currentBooking.id,
          transition_event_type: input.transitionEventType,
          source_operation: input.sourceOperation,
          side_effect_id: effect.id,
          side_effect_intent: effect.effect_intent,
          side_effect_status_after: 'failed_or_dead',
          failure_reason: failureReason,
          branch_taken: 'realtime_side_effect_failed_recorded_for_retry',
        },
      });
    }
  }

  return currentBooking;
}

async function executeImmediateTransitionSideEffect(
  effect: BookingSideEffect,
  booking: Booking,
  transition: {
    transitionEventType: BookingEventType;
    sourceOperation: string;
  },
  ctx: BookingContext,
): Promise<Booking> {
  switch (effect.effect_intent) {
    case 'SEND_BOOKING_CONFIRMATION_REQUEST': {
      const bookingEvent = await ctx.providers.repository.getBookingEventById(effect.booking_event_id);
      const confirmToken = typeof bookingEvent?.payload?.['confirm_token'] === 'string'
        ? bookingEvent.payload['confirm_token'] as string
        : null;

      if (!confirmToken) {
        const viaLateAccess = bookingEvent?.payload?.['via_late_access'] === true;
        if (viaLateAccess) {
          ctx.logger.logInfo?.({
            source: 'backend',
            eventType: 'realtime_side_effect_noop',
            message: 'Skipped confirmation email for late-access booking',
            context: {
              booking_id: booking.id,
              transition_event_type: transition.transitionEventType,
              source_operation: transition.sourceOperation,
              side_effect_id: effect.id,
              side_effect_intent: effect.effect_intent,
              branch_taken: 'skip_confirmation_email_late_access_flow',
              deny_reason: 'late_access_booking_has_no_confirm_token',
            },
          });
          return booking;
        }
        throw new Error('confirm_token_missing');
      }

      const confirmUrl = buildConfirmUrl(bookingSiteUrl(ctx), confirmToken);
      await sendEmailConfirmation(booking, confirmUrl, ctx);
      return booking;
    }

    case 'UPDATE_CALENDAR_SLOT': {
      const result = await retryCalendarSyncForBooking(booking, 'update', ctx);
      if (!result.calendarSynced) {
        if (result.retryableFailure) {
          throw new RetryableCalendarWriteError(
            result.failureReason ?? 'calendar_sync_failed',
            { statusCode: null, reason: result.retryableFailureReason },
          );
        }
        throw new Error(result.failureReason ?? 'calendar_sync_failed');
      }
      return result.booking;
    }

    case 'CANCEL_CALENDAR_SLOT': {
      const result = await retryCalendarSyncForBooking(booking, 'delete', ctx);
      if (!result.calendarSynced) {
        if (result.retryableFailure) {
          throw new RetryableCalendarWriteError(
            result.failureReason ?? 'calendar_sync_failed',
            { statusCode: null, reason: result.retryableFailureReason },
          );
        }
        throw new Error(result.failureReason ?? 'calendar_sync_failed');
      }
      return result.booking;
    }

    case 'SEND_BOOKING_EXPIRATION_NOTIFICATION': {
      await ctx.providers.email.sendBookingExpired(booking, buildStartNewBookingUrl(bookingSiteUrl(ctx), booking));
      return booking;
    }

    case 'SEND_BOOKING_CANCELLATION_CONFIRMATION': {
      await sendBookingCancellationConfirmation(booking, ctx);
      return booking;
    }

    case 'SEND_BOOKING_CONFIRMATION': {
      await sendBookingFinalConfirmation(booking, ctx);
      return booking;
    }

    case 'SEND_BOOKING_REFUND_CONFIRMATION': {
      await sendRefundConfirmationEmailForBooking(booking, effect, ctx);
      return booking;
    }

    case 'CREATE_STRIPE_REFUND': {
      await initiateAutomaticCancellationRefund(booking, ctx);
      return booking;
    }

    default:
      throw new Error(`realtime_side_effect_unsupported:${effect.effect_intent}`);
  }
}

async function applyImmediateReservationForTransition(
  input: {
    transitionEventType: BookingEventType;
    sourceOperation: string;
    bookingBeforeTransition: Booking;
    bookingAfterTransition: Booking;
    transitionSideEffects: BookingSideEffect[];
  },
  ctx: BookingContext,
): Promise<Booking> {
  const { logger } = ctx;
  const shouldReserveNow = shouldReserveSlotForTransition({
    booking: input.bookingAfterTransition,
    eventType: input.transitionEventType,
    previousStatus: input.bookingBeforeTransition.current_status,
    nextStatus: input.bookingAfterTransition.current_status,
  });
  const reservationEffects = input.transitionSideEffects.filter((effect) => effect.effect_intent === 'RESERVE_CALENDAR_SLOT');

  logger.logInfo?.({
    source: 'backend',
    eventType: 'calendar_reservation_transition_decision',
    message: 'Evaluated immediate calendar reservation eligibility',
    context: {
      booking_id: input.bookingAfterTransition.id,
      transition_event_type: input.transitionEventType,
      source_operation: input.sourceOperation,
      current_status_before: input.bookingBeforeTransition.current_status,
      current_status_after: input.bookingAfterTransition.current_status,
      booking_kind: input.bookingAfterTransition.event_id ? 'event' : 'session',
      has_google_event_id: Boolean(input.bookingAfterTransition.google_event_id),
      reservation_effect_ids: reservationEffects.map((effect) => effect.id),
      reservation_effect_statuses: reservationEffects.map((effect) => effect.status),
      should_reserve_now: shouldReserveNow,
      branch_taken: shouldReserveNow ? 'immediate_reservation_attempt' : 'reservation_skipped',
      deny_reason: shouldReserveNow
        ? null
        : reservationSkipReason(
          input.transitionEventType,
          input.bookingBeforeTransition,
          input.bookingAfterTransition,
        ),
    },
  });

  if (!shouldReserveNow) {
    return applyImmediateNonCronSideEffectsForTransition({
      transitionEventType: input.transitionEventType,
      sourceOperation: `${input.sourceOperation}:non_reservation`,
      bookingBeforeTransition: input.bookingBeforeTransition,
      bookingAfterTransition: input.bookingAfterTransition,
      transitionSideEffects: input.transitionSideEffects,
    }, ctx);
  }

  if (reservationEffects.length === 0) {
    logger.logError?.({
      source: 'backend',
      eventType: 'calendar_reservation_side_effect_missing',
      message: 'Immediate reservation expected a calendar side effect but none was created',
      context: {
        booking_id: input.bookingAfterTransition.id,
        transition_event_type: input.transitionEventType,
        source_operation: input.sourceOperation,
        current_status_before: input.bookingBeforeTransition.current_status,
        current_status_after: input.bookingAfterTransition.current_status,
        failure_reason: 'calendar_side_effect_missing_for_transition',
        deny_reason: 'no_reserve_calendar_slot_side_effect',
      },
    });
    throw new Error('calendar_side_effect_missing_for_transition');
  }

  const operation: 'create' | 'update' = input.bookingAfterTransition.google_event_id ? 'update' : 'create';

  logger.logInfo?.({
    source: 'backend',
    eventType: 'calendar_reservation_attempt_started',
    message: 'Immediate calendar reservation started',
    context: {
      booking_id: input.bookingAfterTransition.id,
      transition_event_type: input.transitionEventType,
      source_operation: input.sourceOperation,
      calendar_operation: operation,
      reservation_effect_count: reservationEffects.length,
      reservation_effect_ids: reservationEffects.map((effect) => effect.id),
      reservation_effect_statuses_before: reservationEffects.map((effect) => effect.status),
      branch_taken: `execute_side_effect_and_sync_${operation}_immediately`,
    },
  });

  await markSideEffectsProcessing(reservationEffects, ctx);
  const syncResult = await retryCalendarSyncForBooking(input.bookingAfterTransition, operation, ctx);

  if (!syncResult.calendarSynced) {
    const failureReason = syncResult.failureReason ?? 'calendar_sync_failed';
    await recordSideEffectAttempts(reservationEffects, {
      status: 'FAILED',
      errorMessage: failureReason,
      apiLogId: consumeLatestProviderApiLogId(ctx.operation),
      ctx,
      bookingId: input.bookingAfterTransition.id,
      logSource: 'backend',
      enableCalendarBackoff: syncResult.retryableFailure,
    });

    logger.logWarn?.({
      source: 'backend',
      eventType: 'calendar_reservation_attempt_completed',
      message: 'Immediate calendar reservation failed; retry path retained',
      context: {
        booking_id: input.bookingAfterTransition.id,
        transition_event_type: input.transitionEventType,
        source_operation: input.sourceOperation,
        calendar_operation: operation,
        reservation_effect_count: reservationEffects.length,
        reservation_effect_ids: reservationEffects.map((effect) => effect.id),
        calendar_synced: false,
        branch_taken: 'side_effect_failed_recorded_for_retry',
        failure_reason: failureReason,
      },
    });

    await sendCalendarReservationFailureAlert({
      booking: syncResult.booking,
      transitionEventType: input.transitionEventType,
      sourceOperation: input.sourceOperation,
      failureReason,
      reservationEffectIds: reservationEffects.map((effect) => effect.id),
    }, ctx);

    return applyImmediateNonCronSideEffectsForTransition({
      transitionEventType: input.transitionEventType,
      sourceOperation: `${input.sourceOperation}:post_reservation_failure`,
      bookingBeforeTransition: input.bookingBeforeTransition,
      bookingAfterTransition: syncResult.booking,
      transitionSideEffects: input.transitionSideEffects.filter((effect) => effect.effect_intent !== 'RESERVE_CALENDAR_SLOT'),
    }, ctx);
  }

  await recordSideEffectAttempts(reservationEffects, {
    status: 'SUCCESS',
    errorMessage: null,
    apiLogId: consumeLatestProviderApiLogId(ctx.operation),
    ctx,
    bookingId: input.bookingAfterTransition.id,
    logSource: 'backend',
  });

  const finalBooking = syncResult.booking;

  logger.logInfo?.({
    source: 'backend',
    eventType: 'calendar_reservation_attempt_completed',
    message: 'Immediate calendar reservation succeeded',
    context: {
      booking_id: finalBooking.id,
      transition_event_type: input.transitionEventType,
      source_operation: input.sourceOperation,
      calendar_operation: operation,
      reservation_effect_count: reservationEffects.length,
      reservation_effect_ids: reservationEffects.map((effect) => effect.id),
      calendar_synced: true,
      slot_confirmed_event_written: false,
      branch_taken: 'side_effect_succeeded_immediate_reservation',
    },
  });

  return applyImmediateNonCronSideEffectsForTransition({
    transitionEventType: input.transitionEventType,
    sourceOperation: `${input.sourceOperation}:post_reservation`,
    bookingBeforeTransition: input.bookingBeforeTransition,
    bookingAfterTransition: finalBooking,
    transitionSideEffects: input.transitionSideEffects.filter((effect) => effect.effect_intent !== 'RESERVE_CALENDAR_SLOT'),
  }, ctx);
}

async function sendCalendarReservationFailureAlert(
  input: {
    booking: Booking;
    transitionEventType: BookingEventType;
    sourceOperation: string;
    failureReason: string;
    reservationEffectIds: string[];
  },
  ctx: BookingContext,
): Promise<void> {
  const { logger } = ctx;
  logger.logInfo?.({
    source: 'backend',
    eventType: 'calendar_reservation_failure_alert_decision',
    message: 'Evaluated operational alert dispatch for calendar reservation failure',
    context: {
      booking_id: input.booking.id,
      transition_event_type: input.transitionEventType,
      source_operation: input.sourceOperation,
      reservation_effect_ids: input.reservationEffectIds,
      failure_reason: input.failureReason,
      should_send_alert: true,
      branch_taken: 'send_operational_alert_email',
    },
  });

  const message = [
    'Calendar reservation failed and was queued for retry.',
    `booking_id: ${input.booking.id}`,
    `transition_event_type: ${input.transitionEventType}`,
    `source_operation: ${input.sourceOperation}`,
    `booking_status: ${input.booking.current_status}`,
    `booking_kind: ${input.booking.event_id ? 'event' : 'session'}`,
    `reservation_effect_ids: ${input.reservationEffectIds.join(', ') || 'none'}`,
    `failure_reason: ${input.failureReason}`,
    `request_id: ${ctx.requestId}`,
  ].join('\n');

  try {
    await ctx.providers.email.sendContactMessage(
      'Booking Ops Alert',
      'alerts@yairb.ch',
      message,
      'calendar_reservation_failure',
    );
    logger.logInfo?.({
      source: 'backend',
      eventType: 'calendar_reservation_failure_alert_sent',
      message: 'Operational alert email sent for calendar reservation failure',
      context: {
        booking_id: input.booking.id,
        transition_event_type: input.transitionEventType,
        source_operation: input.sourceOperation,
        reservation_effect_ids: input.reservationEffectIds,
        branch_taken: 'operational_alert_sent',
      },
    });
  } catch (error) {
    logger.logError?.({
      source: 'backend',
      eventType: 'calendar_reservation_failure_alert_failed',
      message: 'Operational alert email failed for calendar reservation failure',
      context: {
        booking_id: input.booking.id,
        transition_event_type: input.transitionEventType,
        source_operation: input.sourceOperation,
        reservation_effect_ids: input.reservationEffectIds,
        failure_reason: toSyncFailureReason(error),
        branch_taken: 'operational_alert_send_failed',
      },
    });
  }
}

function toSyncFailureReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

async function inferPaymentModeForBooking(
  bookingId: string,
  repository: Providers['repository'],
): Promise<'free' | 'pay_now' | 'pay_later' | null> {
  const booking = await repository.getBookingById(bookingId);
  if (!booking) return null;
  if (booking.booking_type === 'FREE') return 'free';
  if (booking.booking_type === 'PAY_NOW') return 'pay_now';
  if (booking.booking_type === 'PAY_LATER') return 'pay_later';
  return null;
}

async function resolveChargeableForBooking(
  booking: Booking,
  repository: Providers['repository'],
): Promise<Pick<SessionTypeRecord, 'title' | 'price' | 'currency'>> {
  if (booking.session_type_title?.trim()) {
    return {
      title: booking.session_type_title.trim(),
      price: Math.max(0, booking.price),
      currency: booking.currency || 'CHF',
    };
  }

  if (booking.event_title?.trim()) {
    return {
      title: booking.event_title.trim(),
      price: Math.max(0, booking.price),
      currency: booking.currency || 'CHF',
    };
  }

  if (booking.session_type_id) {
    const sessionTypes = await repository.getAllSessionTypes();
    const sessionType = sessionTypes.find((row) => row.id === booking.session_type_id) ?? null;
    if (sessionType) {
      return {
        title: sessionType.title,
        price: Math.max(0, booking.price),
        currency: booking.currency || sessionType.currency || 'CHF',
      };
    }
  }

  return {
    title: booking.event_id ? 'ILLUMINATE Event' : 'ILLUMINATE Session',
    price: Math.max(0, booking.price),
    currency: booking.currency || 'CHF',
  };
}

async function ensurePayLaterPendingPaymentRecord(
  booking: Booking,
  ctx: BookingContext,
  bootstrapSource: string,
): Promise<Payment> {
  const { logger } = ctx;
  const existingPayment = await ctx.providers.repository.getPaymentByBookingId(booking.id);

  logger.logInfo?.({
    source: 'backend',
    eventType: 'pay_later_payment_row_decision',
    message: 'Evaluated pay-later payment row readiness',
    context: {
      booking_id: booking.id,
      bootstrap_source: bootstrapSource,
      payment_exists: Boolean(existingPayment),
      payment_status: existingPayment?.status ?? null,
      amount: Math.max(0, booking.price),
      currency: booking.currency || 'CHF',
      branch_taken: existingPayment ? 'reuse_existing_payment_row' : 'create_pending_payment_row',
      deny_reason: null,
    },
  });

  if (existingPayment) {
    if (
      !isPaymentSettledStatus(existingPayment.status)
      && (existingPayment.amount !== Math.max(0, booking.price) || existingPayment.currency !== (booking.currency || 'CHF'))
    ) {
      return ctx.providers.repository.updatePayment(existingPayment.id, {
        amount: Math.max(0, booking.price),
        currency: booking.currency || 'CHF',
        raw_payload: {
          ...(existingPayment.raw_payload ?? {}),
          bootstrap_source: bootstrapSource,
        },
      });
    }
    return existingPayment;
  }

  return ctx.providers.repository.createPayment({
    booking_id: booking.id,
    provider: 'stripe',
    amount: Math.max(0, booking.price),
    currency: booking.currency || 'CHF',
    status: 'PENDING',
    checkout_url: null,
    invoice_url: null,
    raw_payload: {
      bootstrap_source: bootstrapSource,
    },
    paid_at: null,
    stripe_customer_id: null,
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    stripe_invoice_id: null,
    stripe_payment_link_id: null,
    stripe_receipt_url: null,
    refund_status: 'NONE',
    refund_amount: null,
    refund_currency: null,
    stripe_refund_id: null,
    stripe_credit_note_id: null,
    stripe_credit_note_url: null,
    refunded_at: null,
    refund_reason: null,
  });
}

async function ensurePayLaterInvoiceForBooking(
  booking: Booking,
  ctx: BookingContext,
  options: {
    bootstrapSource: string;
    allowProviderFailure?: boolean;
  },
): Promise<Payment | null> {
  const { logger } = ctx;
  const payment = await ensurePayLaterPendingPaymentRecord(booking, ctx, options.bootstrapSource);
  const existingPaymentUrl = paymentProviderUrl(payment);

  logger.logInfo?.({
    source: 'backend',
    eventType: 'pay_later_invoice_decision',
    message: 'Evaluated pay-later invoice readiness',
    context: {
      booking_id: booking.id,
      booking_kind: booking.event_id ? 'event' : 'session',
      session_type_id: booking.session_type_id,
      payment_id: payment.id,
      payment_status: payment.status,
      has_invoice_url: Boolean(payment.invoice_url),
      has_checkout_url: Boolean(payment.checkout_url),
      bootstrap_source: options.bootstrapSource,
      branch_taken: existingPaymentUrl
        ? 'reuse_existing_invoice_url'
        : booking.event_id
          ? 'skip_event_booking_no_pay_later_invoice'
          : 'evaluate_invoice_creation',
      deny_reason: existingPaymentUrl
        ? null
        : booking.event_id
          ? 'event_bookings_do_not_use_pay_later_invoice'
          : null,
    },
  });

  if (existingPaymentUrl) return payment;
  if (booking.event_id) return payment;

  const chargeable = await resolveChargeableForBooking(booking, ctx.providers.repository);
  if (chargeable.price <= 0) {
    logger.logInfo?.({
      source: 'backend',
      eventType: 'pay_later_invoice_not_required',
      message: 'Skipped pay-later invoice for free session type',
      context: {
        booking_id: booking.id,
        session_type_id: booking.session_type_id,
        session_price: booking.price,
        bootstrap_source: options.bootstrapSource,
        branch_taken: 'free_session_no_invoice',
        deny_reason: 'session_price_is_zero',
      },
    });
    return payment;
  }

  try {
    const invoice = await ctx.providers.payments.createInvoice({
      title: chargeable.title,
      amount: chargeable.price,
      currency: chargeable.currency || 'CHF',
      bookingId: booking.id,
      siteUrl: bookingSiteUrl(ctx),
      customerEmail: booking.client_email ?? '',
      customerName: [booking.client_first_name, booking.client_last_name].filter(Boolean).join(' ') || booking.client_email || null,
      existingStripeCustomerId: payment.stripe_customer_id,
      dueDateIso: getPaymentDueAtIso(booking.starts_at, (await loadBookingPolicy(ctx)).paymentDueBeforeStartHours),
      idempotencyKey: `booking:${booking.id}:pay-later-invoice`,
      metadata: {
        booking_id: booking.id,
        booking_kind: booking.event_id ? 'event' : 'session',
        payment_kind: 'pay_later',
      },
    });

    const updatedPayment = await ctx.providers.repository.updatePayment(payment.id, {
      amount: invoice.amount,
      currency: invoice.currency,
      status: 'INVOICE_SENT',
      checkout_url: null,
      invoice_url: invoice.invoiceUrl,
      stripe_customer_id: invoice.customerId,
      stripe_payment_intent_id: invoice.paymentIntentId,
      stripe_invoice_id: invoice.invoiceId,
      stripe_payment_link_id: invoice.paymentLinkId,
      raw_payload: {
        ...(payment.raw_payload ?? {}),
        invoice_response: invoice.rawPayload ?? null,
        bootstrap_source: options.bootstrapSource,
        settlement_source: payment.raw_payload?.['settlement_source'] ?? null,
      },
    });

    logger.logInfo?.({
      source: 'backend',
      eventType: 'pay_later_invoice_created',
      message: 'Created pay-later invoice',
      context: {
        booking_id: booking.id,
        payment_id: updatedPayment.id,
        session_type_id: booking.session_type_id,
        bootstrap_source: options.bootstrapSource,
        invoice_url_present: Boolean(invoice.invoiceUrl),
        stripe_invoice_id: invoice.invoiceId,
        stripe_customer_id: invoice.customerId,
        payment_status_after: updatedPayment.status,
        branch_taken: 'created_invoice_for_pay_later_flow',
      },
    });
    return updatedPayment;
  } catch (error) {
    logger.logWarn?.({
      source: 'backend',
      eventType: 'pay_later_invoice_failed',
      message: 'Pay-later invoice bootstrap failed; payment row retained',
      context: {
        booking_id: booking.id,
        payment_id: payment.id,
        bootstrap_source: options.bootstrapSource,
        payment_status_before: payment.status,
        branch_taken: 'keep_pending_payment_without_invoice',
        deny_reason: 'invoice_bootstrap_failed',
        failure_reason: error instanceof Error ? error.message : String(error),
      },
    });

    if (!options.allowProviderFailure) {
      throw error;
    }

    return ctx.providers.repository.updatePayment(payment.id, {
      status: 'PENDING',
      raw_payload: {
        ...(payment.raw_payload ?? {}),
        bootstrap_source: options.bootstrapSource,
      },
    });
  }
}

async function ensureContinuePaymentUrlForBooking(
  booking: Booking,
  payment: Payment,
  ctx: BookingContext,
): Promise<Payment | null> {
  const chargeable = await resolveChargeableForBooking(booking, ctx.providers.repository);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'continue_payment_bootstrap_decision',
    message: 'Evaluated continue-payment bootstrap for missing checkout URL',
    context: {
      booking_id: booking.id,
      payment_id: payment.id,
      booking_status: booking.current_status,
      payment_status: payment.status,
      has_checkout_url: Boolean(payment.checkout_url),
      has_invoice_url: Boolean(payment.invoice_url),
      branch_taken: 'create_checkout_session_for_missing_checkout_url',
      deny_reason: null,
    },
  });

  try {
    const session = await ctx.providers.payments.createCheckoutSession({
      lineItems: [
        {
          name: chargeable.title,
          amount: Math.max(0, payment.amount || chargeable.price),
          currency: payment.currency || chargeable.currency || 'CHF',
          quantity: 1,
        },
      ],
      bookingId: booking.id,
      customerEmail: booking.client_email ?? '',
      customerName: [booking.client_first_name, booking.client_last_name].filter(Boolean).join(' ') || booking.client_email || null,
      existingStripeCustomerId: payment.stripe_customer_id,
      siteUrl: bookingSiteUrl(ctx),
      successUrl: buildCheckoutSuccessUrl(bookingSiteUrl(ctx), booking.id),
      cancelUrl: buildCheckoutCancelUrl(bookingSiteUrl(ctx), booking.id),
      idempotencyKey: `booking:${booking.id}:continue-payment-checkout`,
      metadata: {
        booking_id: booking.id,
        booking_kind: booking.event_id ? 'event' : 'session',
        payment_kind: 'pay_later_recovery',
      },
    });

    const updatedPayment = await ctx.providers.repository.updatePayment(payment.id, {
      amount: session.amount,
      currency: session.currency,
      status: payment.invoice_url ? payment.status : 'PENDING',
      checkout_url: session.checkoutUrl,
      invoice_url: payment.invoice_url ?? null,
      stripe_customer_id: session.customerId,
      stripe_checkout_session_id: session.sessionId,
      stripe_payment_intent_id: session.paymentIntentId,
      raw_payload: {
        ...(payment.raw_payload ?? {}),
        checkout_session_response: session.rawPayload ?? null,
        bootstrap_source: 'continue_payment',
        prior_payment_status: payment.status,
      },
    });

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'continue_payment_bootstrap_completed',
      message: 'Bootstrapped continue-payment checkout session',
      context: {
        booking_id: booking.id,
        payment_id: updatedPayment.id,
        prior_payment_status: payment.status,
        payment_status_after: updatedPayment.status,
        stripe_checkout_session_id: updatedPayment.stripe_checkout_session_id,
        has_checkout_url: Boolean(updatedPayment.checkout_url),
        has_invoice_url: Boolean(updatedPayment.invoice_url),
        branch_taken: 'continue_payment_checkout_created',
        deny_reason: null,
      },
    });
    return updatedPayment;
  } catch (error) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'continue_payment_bootstrap_failed',
      message: 'Continue-payment bootstrap failed',
      context: {
        booking_id: booking.id,
        payment_id: payment.id,
        payment_status: payment.status,
        branch_taken: 'continue_payment_checkout_failed',
        deny_reason: 'checkout_bootstrap_failed',
        failure_reason: error instanceof Error ? error.message : String(error),
      },
    });
    return payment;
  }
}

async function ensureCheckoutForBooking(
  booking: Booking,
  chargeable: Pick<SessionTypeRecord, 'title' | 'price' | 'currency'> & {
    clientEmail: string;
    clientName?: string | null;
  },
  ctx: BookingContext,
): Promise<{ checkoutUrl: string; expiresAt: string; effectApiLogId: string | null }> {
  const policy = await loadBookingPolicy(ctx);
  const checkoutWindowMs = policy.payNowCheckoutWindowMinutes * 60_000;
  const existing = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  if (existing?.checkout_url) {
    const event = await ctx.providers.repository.getLatestBookingEvent(booking.id);
    const fallbackExpiry = event
      ? new Date(new Date(event.created_at).getTime() + checkoutWindowMs).toISOString()
      : new Date(Date.now() + checkoutWindowMs).toISOString();
    return {
      checkoutUrl: existing.checkout_url,
      expiresAt: fallbackExpiry,
      effectApiLogId: null,
    };
  }

  const session = await ctx.providers.payments.createCheckoutSession({
    lineItems: [
      {
        name: chargeable.title,
        amount: Math.max(0, chargeable.price),
        currency: chargeable.currency || 'CHF',
        quantity: 1,
      },
    ],
    bookingId: booking.id,
    customerEmail: chargeable.clientEmail,
    customerName: chargeable.clientName ?? null,
    existingStripeCustomerId: existing?.stripe_customer_id ?? null,
    siteUrl: bookingSiteUrl(ctx),
    successUrl: buildCheckoutSuccessUrl(bookingSiteUrl(ctx), booking.id),
    cancelUrl: buildCheckoutCancelUrl(bookingSiteUrl(ctx), booking.id),
    idempotencyKey: `booking:${booking.id}:pay-now-checkout`,
    metadata: {
      booking_id: booking.id,
      booking_kind: booking.event_id ? 'event' : 'session',
      payment_kind: 'pay_now',
    },
  });

  if (existing) {
    await ctx.providers.repository.updatePayment(existing.id, {
      amount: session.amount,
      currency: session.currency,
      status: 'PENDING',
      checkout_url: session.checkoutUrl,
      invoice_url: null,
      stripe_customer_id: session.customerId,
      stripe_checkout_session_id: session.sessionId,
      stripe_payment_intent_id: session.paymentIntentId,
      stripe_invoice_id: null,
      stripe_payment_link_id: null,
      raw_payload: {
        ...(existing.raw_payload ?? {}),
        checkout_session_response: session.rawPayload ?? null,
      },
    });
  } else {
    await ctx.providers.repository.createPayment({
      booking_id: booking.id,
      provider: 'stripe',
      amount: session.amount,
      currency: session.currency,
      status: 'PENDING',
      checkout_url: session.checkoutUrl,
      invoice_url: null,
      raw_payload: {
        checkout_session_response: session.rawPayload ?? null,
      },
      paid_at: null,
      stripe_customer_id: session.customerId,
      stripe_checkout_session_id: session.sessionId,
      stripe_payment_intent_id: session.paymentIntentId,
      stripe_invoice_id: null,
      stripe_payment_link_id: null,
      stripe_receipt_url: null,
      refund_status: 'NONE',
      refund_amount: null,
      refund_currency: null,
      stripe_refund_id: null,
      stripe_credit_note_id: null,
      stripe_credit_note_url: null,
      refunded_at: null,
      refund_reason: null,
    });
  }

  const latestEvent = await ctx.providers.repository.getLatestBookingEvent(booking.id);
  const expiresAt = latestEvent
    ? new Date(new Date(latestEvent.created_at).getTime() + checkoutWindowMs).toISOString()
    : new Date(Date.now() + checkoutWindowMs).toISOString();

  return {
    checkoutUrl: session.checkoutUrl,
    expiresAt,
    effectApiLogId: consumeLatestProviderApiLogId(ctx.operation),
  };
}

async function markCheckoutSideEffectAttempt(
  effects: Array<{ id: string; effect_intent: string; max_attempts: number }>,
  apiLogId: string | null,
  status: 'SUCCESS' | 'FAILED',
  errorMessage: string | null,
  ctx: BookingContext,
): Promise<void> {
  const checkoutEffect = effects.find((effect) => effect.effect_intent === 'CREATE_STRIPE_CHECKOUT');
  if (!checkoutEffect) return;

  const lastAttempt = await ctx.providers.repository.getLastBookingSideEffectAttempt(checkoutEffect.id);
  const attemptNum = (lastAttempt?.attempt_num ?? 0) + 1;

  const createdAttempt = await ctx.providers.repository.createBookingSideEffectAttempt({
    booking_side_effect_id: checkoutEffect.id,
    attempt_num: attemptNum,
    api_log_id: apiLogId || null,
    status,
    error_message: errorMessage,
  });
  if (ctx.operation) {
    extendOperationContext(ctx.operation, {
      sideEffectId: checkoutEffect.id,
      sideEffectAttemptId: createdAttempt.id,
    });
  }
  await syncApiLogOperationReferences(ctx.env, apiLogId, ctx.operation);

  if (status === 'SUCCESS') {
    await ctx.providers.repository.updateBookingSideEffect(checkoutEffect.id, { status: 'SUCCESS' });
    return;
  }

  const nextStatus = attemptNum >= checkoutEffect.max_attempts ? 'DEAD' : 'FAILED';
  await ctx.providers.repository.updateBookingSideEffect(checkoutEffect.id, { status: nextStatus });
}

async function markSideEffectsProcessing(
  effects: Array<Pick<BookingSideEffect, 'id'>>,
  ctx: BookingContext,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  for (const effect of effects) {
    await ctx.providers.repository.updateBookingSideEffect(effect.id, {
      status: 'PROCESSING',
      updated_at: updatedAt,
    });
  }
}
