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
  BookingEventType,
  BookingSideEffect,
  Event,
  SessionTypeRecord,
} from '../types.js';
import type { CalendarEvent } from '../providers/calendar/interface.js';
import { createAdminManageToken, generateToken, hashToken, verifyAdminManageToken } from './token-service.js';
import { badRequest, conflict, gone, notFound } from '../lib/errors.js';
import { isEventPublished, normalizeEventRow } from '../lib/content-status.js';
import { appendBookingEventWithEffects } from './booking-transition.js';
import { isTerminalStatus } from '../domain/booking-domain.js';
import {
  DEFAULT_BOOKING_POLICY,
  getBookingPolicyText,
  shouldReserveSlotForTransition,
} from '../domain/booking-effect-policy.js';
import { sideEffectStatusAfterAttempt } from '../providers/repository/interface.js';

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
  'CREATE_STRIPE_CHECKOUT',
  'CREATE_STRIPE_REFUND',
]);

export interface BookingContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
  correlationId?: string;
  operation?: OperationContext;
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

// ── Session booking inputs ─────────────────────────────────────────────────

export interface PayNowInput {
  slotStart: string;
  slotEnd: string;
  timezone: string;
  sessionType: 'intro' | 'session';
  clientName: string;
  clientEmail: string;
  clientPhone: string | null;
  reminderEmailOptIn: boolean;
  reminderWhatsappOptIn: boolean;
  turnstileToken: string;
  remoteIp: string | null;
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
  clientName: string;
  clientEmail: string;
  clientPhone: string | null;
  reminderEmailOptIn: boolean;
  reminderWhatsappOptIn: boolean;
  turnstileToken: string;
  remoteIp: string | null;
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
}

export interface BookingPublicActionInfo {
  booking: Booking;
  checkoutUrl: string | null;
  manageUrl: string | null;
  nextActionUrl: string | null;
  nextActionLabel: 'Complete Payment' | 'Manage Booking' | null;
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

  const sessionType = await resolveSessionTypeForKind('session', providers);
  const booking = await providers.repository.createBooking({
    client_id: client.id,
    event_id: null,
    session_type_id: sessionType.id,
    booking_type: 'PAY_NOW',
    starts_at: input.slotStart,
    ends_at: input.slotEnd,
    timezone: input.timezone,
    google_event_id: null,
    address_line: env.SESSION_ADDRESS,
    maps_url: env.SESSION_MAPS_URL,
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

  const checkout = await ensureCheckoutForBooking(transitioned.booking, sessionType, bookingCtx);
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

  const sessionType = await resolveSessionTypeForKind(input.sessionType, providers);
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
    address_line: env.SESSION_ADDRESS,
    maps_url: env.SESSION_MAPS_URL,
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
    transitionEventType: input.sessionType === 'intro' ? 'BOOKING_FORM_SUBMITTED' : 'BOOKING_FORM_SUBMITTED',
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
  await ensureEventPublicBookable(input.event);
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

  const booking = await providers.repository.createBooking({
    client_id: client.id,
    event_id: input.event.id,
    session_type_id: null,
    booking_type: input.event.is_paid ? 'PAY_NOW' : 'FREE',
    starts_at: input.event.starts_at,
    ends_at: input.event.ends_at,
    timezone: input.event.timezone,
    google_event_id: null,
    address_line: input.event.address_line,
    maps_url: input.event.maps_url,
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
      price: input.event.price_per_person_cents ?? 0,
      currency: input.event.currency,
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
      DEFAULT_BOOKING_POLICY.nonPaidConfirmationWindowMinutes * 60_000,
    ).toISOString()
    : null;
  const isConfirmationWindowExpired = confirmationDeadlineIso
    ? Date.now() > new Date(confirmationDeadlineIso).getTime()
    : true;

  bookingCtx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_email_confirmation_decision',
    message: 'Evaluated email confirmation token redemption',
    context: {
      booking_id: booking.id,
      booking_status: booking.current_status,
      has_submission_with_confirm_token: Boolean(submissionWithToken),
      confirmation_deadline: confirmationDeadlineIso,
      confirmation_window_minutes: DEFAULT_BOOKING_POLICY.nonPaidConfirmationWindowMinutes,
      is_confirmation_window_expired: isConfirmationWindowExpired,
      branch_taken: booking.current_status !== 'PENDING'
        ? 'booking_already_progressed_or_terminal'
        : submissionWithToken
          ? (isConfirmationWindowExpired ? 'deny_confirmation_window_expired' : 'accept_confirmation_within_window')
          : 'deny_missing_submission_for_token',
      deny_reason: booking.current_status !== 'PENDING'
        ? (booking.current_status === 'CONFIRMED'
          ? null
          : 'booking_not_confirmable_in_current_status')
        : submissionWithToken
          ? (isConfirmationWindowExpired ? 'confirmation_window_expired' : null)
          : 'confirm_token_submission_not_found',
    },
  });

  if (booking.current_status !== 'PENDING') {
    if (booking.current_status === 'CONFIRMED') {
      return booking;
    }
    throw gone('This confirmation link is no longer valid');
  }

  if (!submissionWithToken || isConfirmationWindowExpired) {
    throw gone('This confirmation link is no longer valid');
  }

  let finalizedBooking = booking;
  if (booking.booking_type === 'FREE') {
    finalizedBooking = await bookingCtx.providers.repository.updateBooking(booking.id, { current_status: 'CONFIRMED' });
    if (!finalizedBooking.event_id) {
      const syncResult = await retryCalendarSyncForBooking(finalizedBooking, 'create', bookingCtx);
      finalizedBooking = syncResult.booking;
    }
    await sendBookingFinalConfirmation(finalizedBooking, bookingCtx);
  } else {
    const paymentUrl = await ensurePayLaterCheckoutUrlForBooking(booking, bookingCtx);
    if (paymentUrl) {
      const manageUrl = await buildManageUrl(ctx.env.SITE_URL, booking);
      await bookingCtx.providers.email.sendBookingPaymentDue(
        booking,
        paymentUrl,
        manageUrl,
        DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes,
      );
    }
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
  payment: { id: string; booking_id: string; provider_payment_id: string | null },
  stripeData: { paymentIntentId: string | null; invoiceId: string | null; invoiceUrl: string | null },
  ctx: BookingContext,
): Promise<void> {
  const { providers, logger } = ctx;

  await providers.repository.updatePayment(payment.id, {
    status: 'SUCCEEDED',
    paid_at: new Date().toISOString(),
    invoice_url: stripeData.invoiceUrl,
    raw_payload: {
      payment_intent_id: stripeData.paymentIntentId,
      invoice_id: stripeData.invoiceId,
      provider_payment_id: payment.provider_payment_id,
    },
  });

  const booking = await providers.repository.getBookingById(payment.booking_id);
  if (!booking) {
    logger.error('Booking not found for payment', { paymentId: payment.id });
    return;
  }
  const bookingCtx = withBookingOperationContext(ctx, booking.id);

  if (isTerminalStatus(booking.current_status)) {
    logger.warn('Late payment for inactive booking — not reviving', {
      bookingId: booking.id,
      current_status: booking.current_status,
    });

    await providers.repository.createBookingEvent({
      booking_id: booking.id,
      event_type: 'PAYMENT_SETTLED',
      source: 'WEBHOOK',
      payload: {
        late: true,
        prior_status: booking.current_status,
        payment_intent_id: stripeData.paymentIntentId,
        invoice_id: stripeData.invoiceId,
      },
    });

    return;
  }

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    'PAYMENT_SETTLED',
    'WEBHOOK',
    {
      payment_intent_id: stripeData.paymentIntentId,
      invoice_id: stripeData.invoiceId,
      invoice_url: stripeData.invoiceUrl,
    },
    bookingCtx,
  );

  await applyImmediateReservationForTransition({
    transitionEventType: 'PAYMENT_SETTLED',
    sourceOperation: 'confirm_booking_payment',
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
  const secret = String(ctx.env.ADMIN_MANAGE_TOKEN_SECRET || ctx.env.JOB_SECRET || '').trim();
  if (!secret) throw badRequest('Admin manage token secret is not configured');
  const expiresAt = new Date(
    Date.now() + DEFAULT_BOOKING_POLICY.adminManageTokenExpiryMinutes * 60_000,
  ).toISOString();
  const adminToken = await createAdminManageToken(booking.id, secret, expiresAt);
  const manageToken = buildStableManageToken(booking.id);
  const url = `${ctx.env.SITE_URL}/manage.html?token=${encodeURIComponent(manageToken)}&admin_token=${encodeURIComponent(adminToken)}`;
  return { url, adminToken, expiresAt };
}

export async function cancelBooking(
  booking: Booking,
  ctx: BookingContext,
  options: { source?: 'PUBLIC_UI' | 'ADMIN_UI'; bypassPolicyWindow?: boolean } = {},
): Promise<BookingActionResult> {
  const source = options.source ?? 'PUBLIC_UI';
  const policy = evaluateManageBookingPolicy(booking.starts_at);
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

  let finalBooking = await applyImmediateNonCronSideEffectsForTransition({
    transitionEventType: 'BOOKING_CANCELED',
    sourceOperation: 'cancel_booking',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, ctx);

  const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const wasPaid = payment?.status === 'SUCCEEDED';
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
      branch_taken: wasPaid ? 'run_refund_flow' : 'skip_refund_flow_unpaid',
      deny_reason: wasPaid ? null : 'booking_not_paid',
    },
  });
  const refreshedPayment = await ctx.providers.repository.getPaymentByBookingId(booking.id);

  return {
    ok: true,
    code: refreshedPayment?.status === 'REFUNDED' ? 'CANCELED_AND_REFUNDED' : 'CANCELED',
    message: refreshedPayment?.status === 'REFUNDED'
      ? 'Booking cancelled and refund verified.'
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
  const policy = evaluateManageBookingPolicy(booking.starts_at);
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

  const confirmUrl = buildConfirmUrl(ctx.env.SITE_URL, confirmToken);
  await sendEmailConfirmation(booking, confirmUrl, ctx);
}

export async function send24hBookingReminder(booking: Booking, ctx: BookingContext): Promise<void> {
  const manageUrl = await buildManageUrl(ctx.env.SITE_URL, booking);

  if (!booking.event_id) {
    await ctx.providers.email.sendBookingReminder24h(booking, manageUrl);
  } else {
    const event = await ctx.providers.repository.getEventById(booking.event_id);
    if (!event) return;
    await ctx.providers.email.sendEventReminder24h(booking, event, manageUrl);
  }

}

export async function sendBookingFinalConfirmation(booking: Booking, ctx: BookingContext): Promise<void> {
  const manageUrl = await buildManageUrl(ctx.env.SITE_URL, booking);
  const paymentMode = await inferPaymentModeForBooking(booking.id, ctx.providers.repository);
  const payUrl = paymentMode === 'pay_later'
    ? await ensurePayLaterCheckoutUrlForBooking(booking, ctx)
    : null;
  const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const invoiceUrl = payment?.invoice_url ?? null;
  const bookingKind: 'session' | 'event' = booking.event_id ? 'event' : 'session';

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_confirmation_email_dispatch_decision',
    message: 'Evaluated final booking confirmation email dispatch eligibility',
    context: {
      booking_id: booking.id,
      booking_kind: bookingKind,
      booking_status: booking.current_status,
      payment_mode: paymentMode,
      has_google_event_id: Boolean(booking.google_event_id),
      has_manage_url: Boolean(manageUrl),
      has_invoice_url: Boolean(invoiceUrl),
      has_pay_url: Boolean(payUrl),
      branch_taken: !booking.event_id && !booking.google_event_id
        ? 'deny_session_confirmation_until_calendar_synced'
        : 'allow_confirmation_email_dispatch',
      deny_reason: !booking.event_id && !booking.google_event_id
        ? 'session_calendar_invite_missing_before_confirmation_email'
        : null,
    },
  });

  if (!booking.event_id) {
    if (!booking.google_event_id) {
      throw new Error('session_calendar_invite_missing_before_confirmation_email');
    }
    await ctx.providers.email.sendBookingConfirmation(booking, manageUrl, invoiceUrl, payUrl);
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'booking_confirmation_email_dispatch_completed',
      message: 'Session confirmation email sent',
      context: {
        booking_id: booking.id,
        booking_kind: bookingKind,
        booking_status: booking.current_status,
        payment_mode: paymentMode,
        branch_taken: 'session_confirmation_email_sent',
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
  await ctx.providers.email.sendEventConfirmation(booking, event, manageUrl, invoiceUrl);
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_confirmation_email_dispatch_completed',
    message: 'Event confirmation email sent',
    context: {
      booking_id: booking.id,
      booking_kind: bookingKind,
      booking_status: booking.current_status,
      event_id: event.id,
      branch_taken: 'event_confirmation_email_sent',
      deny_reason: null,
    },
  });
}

export async function getBookingPublicActionInfo(
  booking: Booking,
  ctx: BookingContext,
): Promise<BookingPublicActionInfo> {
  const manageUrl = isTerminalStatus(booking.current_status)
    ? null
    : await buildManageUrl(ctx.env.SITE_URL, booking);

  const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  const checkoutUrl =
    payment && payment.status === 'PENDING' && !isTerminalStatus(booking.current_status)
      ? payment.checkout_url
      : null;

  if (checkoutUrl) {
    return {
      booking,
      checkoutUrl,
      manageUrl,
      nextActionUrl: checkoutUrl,
      nextActionLabel: 'Complete Payment',
    };
  }

  return {
    booking,
    checkoutUrl,
    manageUrl,
    nextActionUrl: manageUrl,
    nextActionLabel: manageUrl ? 'Manage Booking' : null,
  };
}

export function evaluateManageBookingPolicy(startsAtIso: string): {
  canSelfServeChange: boolean;
  hoursBeforeStart: number;
  policyText: string;
} {
  const nowMs = Date.now();
  const startsAtMs = new Date(startsAtIso).getTime();
  const hoursBeforeStart = (startsAtMs - nowMs) / 3_600_000;
  return {
    canSelfServeChange: hoursBeforeStart >= DEFAULT_BOOKING_POLICY.selfServiceLockWindowHours,
    hoursBeforeStart,
    policyText: getBookingPolicyText(),
  };
}

export async function getBookingPublicActionInfoByPaymentSession(
  sessionId: string,
  ctx: BookingContext,
): Promise<BookingPublicActionInfo> {
  const payment = await ctx.providers.repository.getPaymentByStripeSessionId(sessionId);
  if (!payment) throw notFound('Payment session not found');

  const booking = await ctx.providers.repository.getBookingById(payment.booking_id);
  if (!booking) throw notFound('Booking not found');

  return getBookingPublicActionInfo(booking, ctx);
}

export async function ensureEventPublicBookable(event: Event): Promise<void> {
  const normalizedEvent = normalizeEventRow(event);
  if (!isEventPublished(normalizedEvent.status)) throw badRequest('Event is not open for booking');
  const nowMs = Date.now();
  const cutoffMs = new Date(normalizedEvent.starts_at).getTime()
    + DEFAULT_BOOKING_POLICY.publicEventCutoffAfterStartMinutes * 60_000;
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

function buildStableManageToken(bookingId: string): string {
  return `m1.${bookingId}`;
}

function buildStartNewBookingUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/g, '')}/book.html`;
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
  if (!booking.event_id) {
    await ctx.providers.email.sendBookingConfirmRequest(booking, confirmUrl, DEFAULT_BOOKING_POLICY.nonPaidConfirmationWindowMinutes);
    return;
  }

  const event = await ctx.providers.repository.getEventById(booking.event_id);
  if (!event) return;
  await ctx.providers.email.sendEventConfirmRequest(booking, event, confirmUrl);
}

function shouldSessionBookingHaveCalendarEvent(booking: Booking): boolean {
  if (booking.event_id) return false;
  return booking.current_status === 'CONFIRMED';
}

function fullClientName(booking: Booking): string {
  return [booking.client_first_name ?? '', booking.client_last_name ?? ''].join(' ').trim() || 'Unknown Client';
}

function buildSessionCalendarEventPayload(booking: Booking, requestId: string): CalendarEvent {
  const durationMinutes = Math.max(1, Math.round(
    (new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime()) / 60000,
  ));

  const descriptionLines = [
    'ILLUMINATE 1:1 session',
    `Client: ${fullClientName(booking)}`,
    `Email: ${booking.client_email ?? 'n/a'}`,
    `Phone: ${booking.client_phone ?? 'n/a'}`,
    `Booking ID: ${booking.id}`,
    `Current status: ${booking.current_status}`,
    `Duration: ${durationMinutes} minutes`,
    `Timezone: ${booking.timezone}`,
  ];

  return {
    title: `ILLUMINATE 1:1 Session — ${fullClientName(booking)}`,
    description: descriptionLines.join('\n'),
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
    return { booking, calendarSynced: true, failureReason: null };
  }

  const needsEvent = shouldSessionBookingHaveCalendarEvent(booking);
  const payload = buildSessionCalendarEventPayload(booking, ctx.requestId);

  if (!needsEvent) {
    if (!booking.google_event_id) {
      return { booking, calendarSynced: true, failureReason: null };
    }

    try {
      await providers.calendar.deleteEvent(booking.google_event_id);
      const updated = await providers.repository.updateBooking(booking.id, { google_event_id: null });
      return { booking: updated, calendarSynced: true, failureReason: null };
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
          const updated = await providers.repository.updateBooking(booking.id, { google_event_id: null });
          return { booking: updated, calendarSynced: true, failureReason: null };
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
          return { booking, calendarSynced: false, failureReason: toSyncFailureReason(persistError) };
        }
      }
      logger.error('Calendar delete failed', {
        bookingId: booking.id,
        operation: options.operation,
        googleEventId: booking.google_event_id,
        error: String(error),
      });
      return { booking, calendarSynced: false, failureReason: toSyncFailureReason(error) };
    }
  }

  if (booking.google_event_id) {
    if (!options.forceUpdate) {
      return { booking, calendarSynced: true, failureReason: null };
    }

    try {
      await providers.calendar.updateEvent(booking.google_event_id, payload);
      return { booking, calendarSynced: true, failureReason: null };
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
          const updated = await providers.repository.updateBooking(booking.id, { google_event_id: created.eventId });
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
          return { booking: updated, calendarSynced: true, failureReason: null };
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
          return { booking, calendarSynced: false, failureReason: toSyncFailureReason(recreateError) };
        }
      }
      logger.error('Calendar update failed', {
        bookingId: booking.id,
        operation: options.operation,
        googleEventId: booking.google_event_id,
        error: String(error),
      });
      return { booking, calendarSynced: false, failureReason: toSyncFailureReason(error) };
    }
  }

  try {
    const created = await providers.calendar.createEvent(payload);
    const updated = await providers.repository.updateBooking(booking.id, { google_event_id: created.eventId });
    return { booking: updated, calendarSynced: true, failureReason: null };
  } catch (error) {
    logger.error('Calendar create failed', {
      bookingId: booking.id,
      operation: options.operation,
      error: String(error),
    });
    return { booking, calendarSynced: false, failureReason: toSyncFailureReason(error) };
  }
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
      await markSideEffectAttemptForEffects(
        [effect],
        'SUCCESS',
        null,
        consumeLatestProviderApiLogId(ctx.operation),
        ctx,
      );

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

      try {
        await markSideEffectAttemptForEffects(
          [effect],
          'FAILED',
          failureReason,
          consumeLatestProviderApiLogId(ctx.operation),
          ctx,
        );
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

      const confirmUrl = buildConfirmUrl(ctx.env.SITE_URL, confirmToken);
      await sendEmailConfirmation(booking, confirmUrl, ctx);
      return booking;
    }

    case 'UPDATE_CALENDAR_SLOT': {
      const result = await retryCalendarSyncForBooking(booking, 'update', ctx);
      if (!result.calendarSynced) {
        throw new Error(result.failureReason ?? 'calendar_sync_failed');
      }
      return result.booking;
    }

    case 'CANCEL_CALENDAR_SLOT': {
      const result = await retryCalendarSyncForBooking(booking, 'delete', ctx);
      if (!result.calendarSynced) {
        throw new Error(result.failureReason ?? 'calendar_sync_failed');
      }
      return result.booking;
    }

    case 'SEND_BOOKING_EXPIRATION_NOTIFICATION': {
      await ctx.providers.email.sendBookingCancellation(booking, buildStartNewBookingUrl(ctx.env.SITE_URL));
      return booking;
    }

    case 'SEND_BOOKING_CANCELLATION_CONFIRMATION': {
      await ctx.providers.email.sendBookingCancellation(booking, null);
      return booking;
    }

    case 'SEND_BOOKING_CONFIRMATION': {
      await sendBookingFinalConfirmation(booking, ctx);
      return booking;
    }

    case 'CREATE_STRIPE_REFUND': {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      if (payment && payment.status !== 'REFUNDED') {
        await ctx.providers.repository.updatePayment(payment.id, { status: 'REFUNDED' });
      }
      await appendBookingEventWithEffects(
        booking.id,
        'REFUND_COMPLETED',
        'SYSTEM',
        { provider: 'stripe', mode: 'simulated' },
        ctx,
      );
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
    await markSideEffectAttemptForEffects(
      reservationEffects,
      'FAILED',
      failureReason,
      consumeLatestProviderApiLogId(ctx.operation),
      ctx,
    );

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

    return syncResult.booking;
  }

  await markSideEffectAttemptForEffects(
    reservationEffects,
    'SUCCESS',
    null,
    consumeLatestProviderApiLogId(ctx.operation),
    ctx,
  );

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

  return finalBooking;
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

async function resolveSessionTypeForKind(
  kind: 'intro' | 'session',
  providers: Providers,
): Promise<SessionTypeRecord> {
  const all = await providers.repository.getPublicSessionTypes();
  if (all.length === 0) {
    throw badRequest('No active session types configured');
  }

  const introCandidate = all.find((row) => row.slug.includes('intro') || row.price === 0);
  const paidCandidate = all.find((row) => row.id !== introCandidate?.id) ?? all[0];

  const selected = kind === 'intro' ? (introCandidate ?? all[0]) : (paidCandidate ?? all[0]);
  if (!selected) {
    throw badRequest('Unable to resolve session type');
  }
  return selected;
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

async function ensurePayLaterCheckoutUrlForBooking(
  booking: Booking,
  ctx: BookingContext,
): Promise<string | null> {
  const { logger } = ctx;
  const existingPayment = await ctx.providers.repository.getPaymentByBookingId(booking.id);

  logger.logInfo?.({
    source: 'backend',
    eventType: 'pay_later_checkout_link_decision',
    message: 'Evaluated pay-later checkout link readiness for confirmation email',
    context: {
      booking_id: booking.id,
      booking_kind: booking.event_id ? 'event' : 'session',
      session_type_id: booking.session_type_id,
      payment_exists: Boolean(existingPayment),
      payment_status: existingPayment?.status ?? null,
      has_checkout_url: Boolean(existingPayment?.checkout_url),
      branch_taken: existingPayment?.checkout_url
        ? 'reuse_existing_checkout_url'
        : booking.event_id
          ? 'skip_event_booking_no_pay_later_checkout'
          : 'evaluate_checkout_creation',
      deny_reason: existingPayment?.checkout_url
        ? null
        : booking.event_id
          ? 'event_bookings_do_not_use_pay_later_checkout'
          : null,
    },
  });

  if (existingPayment?.checkout_url) return existingPayment.checkout_url;
  if (booking.event_id) return null;
  if (!booking.session_type_id) {
    logger.logWarn?.({
      source: 'backend',
      eventType: 'pay_later_checkout_link_missing_session_type',
      message: 'Cannot create pay-later checkout link because session type is missing',
      context: {
        booking_id: booking.id,
        booking_kind: 'session',
        deny_reason: 'session_type_id_missing',
      },
    });
    return null;
  }

  const sessionTypes = await ctx.providers.repository.getAllSessionTypes();
  const sessionType = sessionTypes.find((row) => row.id === booking.session_type_id) ?? null;
  if (!sessionType) {
    logger.logWarn?.({
      source: 'backend',
      eventType: 'pay_later_checkout_link_missing_session_type_record',
      message: 'Cannot create pay-later checkout link because session type record is missing',
      context: {
        booking_id: booking.id,
        session_type_id: booking.session_type_id,
        deny_reason: 'session_type_record_not_found',
      },
    });
    return null;
  }

  if (sessionType.price <= 0) {
    logger.logInfo?.({
      source: 'backend',
      eventType: 'pay_later_checkout_link_not_required',
      message: 'Skipped pay-later checkout link for free session type',
      context: {
        booking_id: booking.id,
        session_type_id: sessionType.id,
        session_price: sessionType.price,
        branch_taken: 'free_session_no_checkout_link',
        deny_reason: 'session_price_is_zero',
      },
    });
    return null;
  }

  const checkout = await ensureCheckoutForBooking(booking, sessionType, ctx);
  logger.logInfo?.({
    source: 'backend',
    eventType: 'pay_later_checkout_link_created',
    message: 'Created pay-later checkout link for confirmation email',
    context: {
      booking_id: booking.id,
      session_type_id: sessionType.id,
      checkout_url_present: Boolean(checkout.checkoutUrl),
      branch_taken: 'created_checkout_for_pay_later_confirmation',
    },
  });
  return checkout.checkoutUrl;
}

async function ensureCheckoutForBooking(
  booking: Booking,
  chargeable: Pick<SessionTypeRecord, 'title' | 'price' | 'currency'>,
  ctx: BookingContext,
): Promise<{ checkoutUrl: string; expiresAt: string; effectApiLogId: string | null }> {
  const checkoutWindowMs = DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes * 60_000;
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
        amountCents: Math.max(0, chargeable.price),
        currency: chargeable.currency || 'CHF',
        quantity: 1,
      },
    ],
    bookingId: booking.id,
    successUrl: `${ctx.env.SITE_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${ctx.env.SITE_URL}/payment-cancel.html?session_id={CHECKOUT_SESSION_ID}`,
  });

  await ctx.providers.repository.createPayment({
    booking_id: booking.id,
    provider: 'stripe',
    provider_payment_id: session.sessionId,
    amount_cents: session.amountCents,
    currency: session.currency,
    status: 'PENDING',
    checkout_url: session.checkoutUrl,
    invoice_url: null,
    raw_payload: null,
    paid_at: null,
  });

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

  await ctx.providers.repository.createBookingSideEffectAttempt({
    booking_side_effect_id: checkoutEffect.id,
    attempt_num: attemptNum,
    api_log_id: apiLogId || null,
    status,
    error_message: errorMessage,
  });

  if (status === 'SUCCESS') {
    await ctx.providers.repository.updateBookingSideEffect(checkoutEffect.id, { status: 'SUCCESS' });
    return;
  }

  const nextStatus = attemptNum >= checkoutEffect.max_attempts ? 'DEAD' : 'FAILED';
  await ctx.providers.repository.updateBookingSideEffect(checkoutEffect.id, { status: nextStatus });
}

async function markSideEffectAttemptForEffects(
  effects: Array<Pick<BookingSideEffect, 'id' | 'max_attempts'>>,
  status: 'SUCCESS' | 'FAILED',
  errorMessage: string | null,
  apiLogId: string | null,
  ctx: BookingContext,
): Promise<void> {
  for (const effect of effects) {
    const lastAttempt = await ctx.providers.repository.getLastBookingSideEffectAttempt(effect.id);
    const attemptNum = (lastAttempt?.attempt_num ?? 0) + 1;
    await ctx.providers.repository.createBookingSideEffectAttempt({
      booking_side_effect_id: effect.id,
      attempt_num: attemptNum,
      api_log_id: apiLogId,
      status,
      error_message: errorMessage,
    });
    const nextStatus = sideEffectStatusAfterAttempt(status, attemptNum, effect.max_attempts);
    await ctx.providers.repository.updateBookingSideEffect(effect.id, { status: nextStatus });
  }
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
