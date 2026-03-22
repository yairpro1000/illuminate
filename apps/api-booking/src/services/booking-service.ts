import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import {
  consumeLatestProviderApiLogId,
  extendOperationContext,
  loggerForOperation,
  type OperationContext,
} from '../lib/execution.js';
import type {
  Booking,
  BookingCurrentStatus,
  BookingEffectIntent,
  BookingEventRecord,
  BookingEventStatus,
  BookingEventType,
  BookingSideEffect,
  Event,
  Payment,
  PaymentStatus,
  SessionTypeRecord,
} from '../types.js';
import { isRetryableCalendarWriteError, type CalendarEvent } from '../providers/calendar/interface.js';
import { createAdminManageToken, generateToken, hashToken } from './token-service.js';
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
  isPaymentSettledStatus,
} from '../domain/payment-status.js';
import {
  inferEntityFromIntent,
} from '../providers/repository/interface.js';
import { applyCouponToPrice, normalizeCouponCode, resolveCouponByCode } from './coupon-service.js';
import { computePaymentDueReminderTime } from './reminder-service.js';
import {
  runBookingEventEffects,
  type BookingEventExecutionResult,
  finalizeBookingEventStatus,
} from './booking-event-workflow.js';
import { createBookingSideEffectExecutor } from './booking-side-effect-executor.js';
import { resolveBookingManageAccess } from './booking-access-service.js';
import { evaluateManageBookingPolicy } from './booking-public-action-service.js';
import {
  effectiveRefundStatus,
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
  bookingPolicyConfig?: Awaited<ReturnType<typeof getBookingPolicyConfig>>;
  bookingPolicyConfigPromise?: Promise<Awaited<ReturnType<typeof getBookingPolicyConfig>>>;
}

async function loadBookingPolicy(ctx: Pick<BookingContext, 'providers'>) {
  const cached = ctx as BookingContext;
  if (cached.bookingPolicyConfig) return cached.bookingPolicyConfig;
  if (!cached.bookingPolicyConfigPromise) {
    cached.bookingPolicyConfigPromise = getBookingPolicyConfig(ctx.providers.repository).then((policy) => {
      cached.bookingPolicyConfig = policy;
      return policy;
    });
  }
  return cached.bookingPolicyConfigPromise;
}

export function bookingSiteUrl(ctx: Pick<BookingContext, 'siteUrl' | 'env'>): string {
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
  bookingEvent?: {
    id: string;
    type: BookingEventType;
    status: string;
  } | null;
  refund?: {
    status: string;
    invoiceUrl: string | null;
    receiptUrl: string | null;
    creditNoteUrl: string | null;
  } | null;
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

export type BookingEventStatusSelector =
  | { mode: 'by_id'; bookingEventId: string }
  | { mode: 'latest_of_type'; bookingId: string; eventType: BookingEventType };

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

export function paymentProviderUrl(payment: Pick<Payment, 'invoice_url' | 'checkout_url'> | null | undefined): string | null {
  return payment?.checkout_url ?? payment?.invoice_url ?? null;
}

function paymentCheckoutUrlForContinuation(payment: Pick<Payment, 'checkout_url'> | null | undefined): string | null {
  return payment?.checkout_url ?? null;
}

function buildCheckoutSuccessUrl(siteUrl: string, bookingId: string): string {
  return `${siteUrl}/payment-success.html?booking_id=${encodeURIComponent(bookingId)}&token=${encodeURIComponent(buildStableManageToken(bookingId))}&booking_event_type=PAYMENT_SETTLED&session_id={CHECKOUT_SESSION_ID}`;
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

function hasReusableContinuePaymentCheckout(
  payment: Pick<Payment, 'checkout_url' | 'status'> | null | undefined,
): boolean {
  return Boolean(payment?.checkout_url) && isPaymentContinuableOnline(payment?.status ?? null);
}

export function canContinuePayLaterPayment(
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

  const executed = await runImmediateBookingEventWorkflow({
    transitionEvent: transitioned.event,
    transitionEventType: 'BOOKING_FORM_SUBMITTED',
    sourceOperation: 'create_pay_now_booking',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, bookingCtx);
  const checkout = requireCheckoutWorkflowResult(executed);

  return {
    bookingId: executed.booking.id,
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

  const finalizedBooking = (await runImmediateBookingEventWorkflow({
    transitionEvent: transitioned.event,
    transitionEventType: 'BOOKING_FORM_SUBMITTED',
    sourceOperation: 'create_pay_later_booking',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, bookingCtx)).booking;

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
    const createdWithImmediateEffects = (await runImmediateBookingEventWorkflow({
      transitionEvent: created.event,
      transitionEventType: 'BOOKING_FORM_SUBMITTED',
      sourceOperation: options.viaLateAccess ? 'create_event_booking_with_access' : 'create_event_booking',
      bookingBeforeTransition: booking,
      bookingAfterTransition: created.booking,
      transitionSideEffects: created.sideEffects,
    }, bookingCtx)).booking;

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

  const executed = await runImmediateBookingEventWorkflow({
    transitionEvent: transitioned.event,
    transitionEventType: 'BOOKING_FORM_SUBMITTED',
    sourceOperation: 'create_event_booking_pay_now',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, bookingCtx);
  const checkout = requireCheckoutWorkflowResult(executed);

  return {
    bookingId: executed.booking.id,
    status: executed.booking.current_status,
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

  const verificationEffects = await listPendingEmailVerificationEffects(submissionWithToken.id, bookingCtx);
  bookingCtx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_email_confirmation_verification_effects_decision',
    message: 'Evaluated pending email-verification side effects during confirmation',
    context: {
      booking_id: booking.id,
      booking_event_id: submissionWithToken.id,
      verification_side_effect_ids: verificationEffects.map((effect) => effect.id),
      verification_side_effect_statuses_before: verificationEffects.map((effect) => effect.status),
      should_execute_verification_workflow: verificationEffects.length > 0,
      branch_taken: verificationEffects.length > 0
        ? 'run_verification_effect_through_shared_event_engine'
        : 'verification_effect_already_completed_or_missing',
      deny_reason: verificationEffects.length > 0 ? null : 'email_verification_effect_already_completed_or_missing',
    },
  });
  let finalizedBooking = (await runBookingEventEffects(
    {
      booking,
      event: submissionWithToken,
      sideEffects: verificationEffects,
      sourceOperation: 'confirm_booking_email_verification',
      triggerSource: 'realtime',
      executeEffect: executeBookingSideEffectAction,
    },
    bookingCtx,
  )).booking;
  if (booking.booking_type !== 'FREE') {
    const payment = await ensurePayLaterPendingPaymentRecord(
      finalizedBooking,
      bookingCtx,
      'booking_email_confirmation',
    );

    await schedulePayLaterPaymentFollowups(finalizedBooking, submissionWithToken.id, bookingCtx);

    bookingCtx.logger.logInfo?.({
      source: 'backend',
      eventType: 'pay_later_confirmation_payment_bootstrap_completed',
      message: 'Confirmed pay-later booking without contacting Stripe',
      context: {
        booking_id: finalizedBooking.id,
        booking_status: finalizedBooking.current_status,
        payment_id: payment.id,
        payment_status: payment.status,
        has_payment_url: Boolean(paymentProviderUrl(payment)),
        has_invoice_url: Boolean(payment.invoice_url),
        has_checkout_url: Boolean(payment.checkout_url),
        branch_taken: 'confirmation_skipped_stripe_bootstrap_until_continue_payment',
        deny_reason: null,
      },
    });
  }

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

  const paymentVerification = await findLatestUnresolvedSideEffectByIntent(
    booking.id,
    'VERIFY_STRIPE_PAYMENT',
    bookingCtx,
  );
  if (paymentVerification) {
    bookingCtx.logger.logInfo?.({
      source: 'backend',
      eventType: 'payment_settlement_verification_resolution_decision',
      message: 'Resolved settled payment through the existing VERIFY_STRIPE_PAYMENT side effect',
      context: {
        booking_id: booking.id,
        payment_id: input.payment.id,
        verification_booking_event_id: paymentVerification.event.id,
        verification_side_effect_id: paymentVerification.effect.id,
        verification_side_effect_status: paymentVerification.effect.status,
        settlement_source: input.settlementSource,
        branch_taken: 'run_existing_verify_stripe_payment_side_effect',
        deny_reason: null,
      },
    });

    await runBookingEventEffects(
      {
        booking,
        event: paymentVerification.event,
        sideEffects: [paymentVerification.effect],
        sourceOperation: input.settlementSource === 'ADMIN_UI'
          ? 'admin_manual_payment_settlement:verify_stripe_payment'
          : 'confirm_booking_payment:verify_stripe_payment',
        triggerSource: 'realtime',
        executeEffect: executeBookingSideEffectAction,
      },
      bookingCtx,
    );
    return;
  }

  bookingCtx.logger.logInfo?.({
    source: 'backend',
    eventType: 'payment_settlement_verification_resolution_decision',
    message: 'No unresolved VERIFY_STRIPE_PAYMENT side effect existed; falling back to direct PAYMENT_SETTLED append',
    context: {
      booking_id: booking.id,
      payment_id: input.payment.id,
      settlement_source: input.settlementSource,
      branch_taken: 'fallback_direct_payment_settled_append',
      deny_reason: 'verify_stripe_payment_side_effect_missing',
    },
  });

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

  await runImmediateBookingEventWorkflow({
    transitionEvent: transitioned.event,
    transitionEventType: 'PAYMENT_SETTLED',
    sourceOperation: input.settlementSource === 'ADMIN_UI'
      ? 'admin_manual_payment_settlement'
      : 'confirm_booking_payment',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, bookingCtx);
}

async function findLatestUnresolvedSideEffectByIntent(
  bookingId: string,
  effectIntent: BookingEffectIntent,
  ctx: BookingContext,
): Promise<{ event: BookingEventRecord; effect: BookingSideEffect } | null> {
  const events = await ctx.providers.repository.listBookingEvents(bookingId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const effects = await ctx.providers.repository.listBookingSideEffectsForEvent(event.id);
    const effect = [...effects].reverse().find((candidate) =>
      candidate.effect_intent === effectIntent
      && candidate.status !== 'SUCCESS'
      && candidate.status !== 'DEAD',
    );
    if (effect) {
      return { event, effect };
    }
  }
  return null;
}

// ── Access and public-action owners were moved to dedicated services ───────

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

  let finalBooking = (await runImmediateBookingEventWorkflow({
    transitionEvent: transitioned.event,
    transitionEventType: 'BOOKING_CANCELED',
    sourceOperation: 'cancel_booking',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, ctx)).booking;

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
  const finalizedEvent = await ctx.providers.repository.getBookingEventById(transitioned.event.id);
  const includeRefundNotice = refundNoticeDecision.includeRefundNotice;
  const refundStatus = effectiveRefundStatus(refreshedPayment);
  const refundArtifacts = refundStatus !== 'NONE'
    ? {
        status: refundStatus,
        invoiceUrl: refreshedPayment?.invoice_url ?? null,
        receiptUrl: refreshedPayment?.stripe_receipt_url ?? null,
        creditNoteUrl: refreshedPayment?.stripe_credit_note_url ?? null,
      }
    : null;

  return {
    ok: true,
    code: refreshedPayment?.status === 'REFUNDED' ? 'CANCELED_AND_REFUNDED' : 'CANCELED',
    message: refundStatus === 'SUCCEEDED'
      ? 'Booking cancelled and refund processed. Your refund documents are ready below, and you\'ll receive a separate confirmation email.'
      : includeRefundNotice
        ? 'Booking cancelled. If a refund applies, you\'ll receive a separate confirmation email.'
        : 'Booking cancelled.',
    booking: finalBooking,
    bookingEvent: {
      id: transitioned.event.id,
      type: transitioned.event.event_type,
      status: finalizedEvent?.status ?? transitioned.event.status,
    },
    refund: refundArtifacts,
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

  const finalizedBooking = (await runImmediateBookingEventWorkflow({
    transitionEvent: result.event,
    transitionEventType: 'BOOKING_EXPIRED',
    sourceOperation: 'expire_booking_verification',
    bookingBeforeTransition: booking,
    bookingAfterTransition: result.booking,
    transitionSideEffects: result.sideEffects,
  }, ctx)).booking;

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

  const finalBooking = (await runImmediateBookingEventWorkflow({
    transitionEvent: transitioned.event,
    transitionEventType: 'BOOKING_RESCHEDULED',
    sourceOperation: 'reschedule_booking',
    bookingBeforeTransition: updated,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, ctx)).booking;
  const finalizedEvent = await ctx.providers.repository.getBookingEventById(transitioned.event.id);
  return {
    ok: true,
    code: 'RESCHEDULED',
    message: 'Booking rescheduled.',
    booking: finalBooking,
    bookingEvent: {
      id: transitioned.event.id,
      type: transitioned.event.event_type,
      status: finalizedEvent?.status ?? transitioned.event.status,
    },
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

async function listPendingEmailVerificationEffects(
  bookingEventId: string,
  ctx: BookingContext,
): Promise<BookingSideEffect[]> {
  const sideEffects = await ctx.providers.repository.listBookingSideEffectsForEvent(bookingEventId);
  return sideEffects.filter((effect) =>
    effect.effect_intent === 'VERIFY_EMAIL_CONFIRMATION' && effect.status !== 'SUCCESS',
  );
}

async function completeEmailVerificationWithinEvent(
  bookingEventId: string,
  booking: Booking,
  ctx: BookingContext,
): Promise<{
  booking: Booking;
  nextSideEffects: BookingSideEffect[];
}> {
  const sideEffects = await ctx.providers.repository.listBookingSideEffectsForEvent(bookingEventId);
  const existingDownstreamSideEffects = sideEffects.filter((effect) =>
    effect.effect_intent === 'RESERVE_CALENDAR_SLOT' || effect.effect_intent === 'SEND_BOOKING_CONFIRMATION',
  );
  const desiredDownstreamIntents: BookingEffectIntent[] = booking.event_id
    ? ['SEND_BOOKING_CONFIRMATION']
    : ['RESERVE_CALENDAR_SLOT', 'SEND_BOOKING_CONFIRMATION'];
  const policy = await loadBookingPolicy(ctx);
  const bookingAfterVerification = booking.current_status === 'PENDING'
    ? await ctx.providers.repository.updateBooking(booking.id, { current_status: 'CONFIRMED' })
    : booking;
  if (bookingAfterVerification.booking_type !== 'FREE') {
    await ensurePayLaterPendingPaymentRecord(
      bookingAfterVerification,
      ctx,
      'confirm_booking_email_verification',
    );
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
    message: 'Completed email confirmation verification and resolved downstream side effects',
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
    booking: bookingAfterVerification,
    nextSideEffects: [...existingDownstreamSideEffects, ...createdDownstreamSideEffects],
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
  const paymentMode = booking.booking_type === 'FREE'
    ? 'free'
    : booking.booking_type === 'PAY_NOW'
      ? 'pay_now'
      : booking.booking_type === 'PAY_LATER'
        ? 'pay_later'
        : null;
  let payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const bookingKind: 'session' | 'event' = booking.event_id ? 'event' : 'session';

  if (paymentMode === 'pay_later' && payment && !isPaymentSettledStatus(payment.status)) {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'booking_confirmation_payment_link_bootstrap_decision',
      message: 'Deferred pay-later Stripe bootstrap until continue-payment is requested',
      context: {
        booking_id: booking.id,
        booking_kind: bookingKind,
        booking_status: booking.current_status,
        payment_id: payment.id,
        payment_status: payment.status,
        has_invoice_url: Boolean(payment.invoice_url),
        has_checkout_url: Boolean(payment.checkout_url),
        should_bootstrap_checkout_link: false,
        branch_taken: 'skip_stripe_bootstrap_until_continue_payment',
        deny_reason: 'confirmation_email_does_not_create_payment_session',
      },
    });
  }

  const isPayLaterPendingConfirmation = paymentMode === 'pay_later' && !isPaymentSettledStatus(payment?.status ?? null);
  const paymentSettledForEmail = isPaymentSettledStatus(payment?.status ?? null);
  const paymentEmailLinks = paymentMode === 'pay_later'
    ? paymentEmailUrl({ booking, payment, siteUrl })
    : { invoiceUrl: payment?.invoice_url ?? null, payUrl: null };
  const payUrl = paymentSettledForEmail ? null : paymentEmailLinks.payUrl;
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

function immediateTransitionEffects(effects: BookingSideEffect[]): BookingSideEffect[] {
  return effects.filter((effect) => shouldRunImmediateTransitionSideEffect(effect.effect_intent));
}

export async function runImmediateBookingEventWorkflow(
  input: {
    transitionEvent: BookingEventRecord;
    transitionEventType: BookingEventType;
    sourceOperation: string;
    bookingBeforeTransition: Booking;
    bookingAfterTransition: Booking;
    transitionSideEffects: BookingSideEffect[];
  },
  ctx: BookingContext,
): Promise<BookingEventExecutionResult> {
  const realtimeEffects = immediateTransitionEffects(input.transitionSideEffects);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'realtime_side_effect_transition_decision',
    message: 'Evaluated immediate booking-event execution plan',
    context: {
      booking_id: input.bookingAfterTransition.id,
      booking_event_id: input.transitionEvent.id,
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
        ? 'run_shared_realtime_booking_event_engine'
        : 'no_realtime_side_effects_for_transition',
      deny_reason: realtimeEffects.length > 0 ? null : 'transition_has_no_non_cron_realtime_side_effects',
    },
  });

  if (realtimeEffects.length === 0) {
    const event = await finalizeBookingEventStatus(input.transitionEvent.id, ctx);
    return {
      booking: input.bookingAfterTransition,
      event,
      sideEffects: input.transitionSideEffects,
      effectResults: [],
    };
  }

  return runBookingEventEffects(
    {
      booking: input.bookingAfterTransition,
      event: input.transitionEvent,
      sideEffects: realtimeEffects,
      sourceOperation: input.sourceOperation,
      triggerSource: 'realtime',
      executeEffect: executeBookingSideEffectAction,
    },
    ctx,
  );
}

export const executeBookingSideEffectAction = createBookingSideEffectExecutor({
  buildConfirmUrl,
  buildContinuePaymentUrl,
  buildManageUrl,
  bookingSiteUrl,
  buildStartNewBookingUrl,
  sendEmailConfirmation,
  sendBookingCancellationConfirmation,
  sendBookingFinalConfirmation,
  send24hBookingReminder,
  sendRefundConfirmationEmailForBooking: async (booking, effect, ctx) => {
    await sendRefundConfirmationEmailForBooking(booking, effect, ctx);
  },
  retryCalendarSyncForBooking,
  ensureCheckoutForBooking,
  initiateAutomaticCancellationRefund,
  completeEmailVerificationWithinEvent,
  expireBooking,
  runImmediateBookingEventWorkflow,
});

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

async function ensureContinuePaymentUrlForBooking(
  booking: Booking,
  payment: Payment,
  ctx: BookingContext,
): Promise<Payment | null> {
  if (hasReusableContinuePaymentCheckout(payment)) {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'continue_payment_bootstrap_decision',
      message: 'Reused existing continue-payment checkout session from local payment state',
      context: {
        booking_id: booking.id,
        payment_id: payment.id,
        booking_status: booking.current_status,
        payment_status: payment.status,
        has_checkout_url: Boolean(payment.checkout_url),
        has_invoice_url: Boolean(payment.invoice_url),
        branch_taken: 'reuse_existing_checkout_session',
        deny_reason: null,
      },
    });
    return payment;
  }

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
      branch_taken: 'create_checkout_session_for_missing_or_unusable_checkout_url',
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
        payment_kind: 'pay_later_continue_payment',
      },
    });

    const updatedPayment = await ctx.providers.repository.updatePayment(payment.id, {
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
  ctx: BookingContext,
): Promise<{ checkoutUrl: string; expiresAt: string }> {
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
    };
  }

  const chargeable = await resolveChargeableForBooking(booking, ctx.providers.repository);
  const client = await ctx.providers.repository.getClientById(booking.client_id);
  const customerEmail = client?.email ?? booking.client_email ?? '';
  const customerName = client
    ? [client.first_name, client.last_name].filter(Boolean).join(' ') || client.email
    : [booking.client_first_name, booking.client_last_name].filter(Boolean).join(' ') || booking.client_email || null;

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
    customerEmail,
    customerName,
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
  };
}

function requireCheckoutWorkflowResult(
  execution: Pick<BookingEventExecutionResult, 'effectResults'>,
): { checkoutUrl: string; expiresAt: string } {
  const checkoutEffect = execution.effectResults.find((effect) => effect.effectIntent === 'CREATE_STRIPE_CHECKOUT');
  const checkoutUrl = typeof checkoutEffect?.metadata?.['checkout_url'] === 'string'
    ? checkoutEffect.metadata['checkout_url']
    : null;
  const expiresAt = typeof checkoutEffect?.metadata?.['checkout_hold_expires_at'] === 'string'
    ? checkoutEffect.metadata['checkout_hold_expires_at']
    : null;
  if (!checkoutUrl || !expiresAt) {
    throw new Error('checkout_workflow_result_missing');
  }
  return { checkoutUrl, expiresAt };
}
