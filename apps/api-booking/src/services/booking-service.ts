import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type {
  Booking,
  BookingCurrentStatus,
  BookingEventType,
  BookingSideEffect,
  Event,
  SessionTypeRecord,
} from '../types.js';
import type { CalendarEvent } from '../providers/calendar/interface.js';
import { generateToken, hashToken } from './token-service.js';
import { badRequest, conflict, gone, notFound } from '../lib/errors.js';
import { appendBookingEventWithEffects } from './booking-transition.js';
import { isTerminalStatus } from '../domain/booking-domain.js';
import { shouldReserveSlotForTransition } from '../domain/booking-effect-policy.js';
import { sideEffectStatusAfterAttempt } from '../providers/repository/interface.js';

const PUBLIC_EVENT_CUTOFF_AFTER_START_MINUTES = 30;

export interface BookingContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
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
    starts_at: input.slotStart,
    ends_at: input.slotEnd,
    timezone: input.timezone,
    google_event_id: null,
    address_line: env.SESSION_ADDRESS,
    maps_url: env.SESSION_MAPS_URL,
    current_status: 'PENDING_CONFIRMATION',
    notes: null,
  });

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    'BOOKING_FORM_SUBMITTED_PAY_NOW',
    'public_ui',
    {
      payment_mode: 'pay_now',
      session_type_id: sessionType.id,
      session_type_slug: sessionType.slug,
    },
    ctx,
  );

  const checkout = await ensureCheckoutForBooking(transitioned.booking, sessionType, ctx);
  await markCheckoutSideEffectAttempt(transitioned.sideEffects, checkout.effectApiLogId, 'success', null, ctx);

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
    starts_at: input.slotStart,
    ends_at: input.slotEnd,
    timezone: input.timezone,
    google_event_id: null,
    address_line: env.SESSION_ADDRESS,
    maps_url: env.SESSION_MAPS_URL,
    current_status: 'PENDING_CONFIRMATION',
    notes: null,
  });

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    input.sessionType === 'intro' ? 'BOOKING_FORM_SUBMITTED_FREE' : 'BOOKING_FORM_SUBMITTED_PAY_LATER',
    'public_ui',
    {
      payment_mode: input.sessionType === 'intro' ? 'free' : 'pay_later',
      session_type_id: sessionType.id,
      session_type_slug: sessionType.slug,
      confirm_token: confirmToken,
      confirm_token_hash: confirmTokenHash,
    },
    ctx,
  );

  // Side-effects dispatcher delivers the email. We still return current cache state.
  return {
    bookingId: transitioned.booking.id,
    status: transitioned.booking.current_status,
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
    starts_at: input.event.starts_at,
    ends_at: input.event.ends_at,
    timezone: input.event.timezone,
    google_event_id: null,
    address_line: input.event.address_line,
    maps_url: input.event.maps_url,
    current_status: 'PENDING_CONFIRMATION',
    notes: null,
  });

  if (!input.event.is_paid) {
    const confirmToken = options.viaLateAccess ? null : generateToken();
    const confirmTokenHash = confirmToken ? await hashToken(confirmToken) : null;

    const created = await appendBookingEventWithEffects(
      booking.id,
      'BOOKING_FORM_SUBMITTED_FREE',
      'public_ui',
      {
        payment_mode: 'free',
        confirm_token: confirmToken,
        confirm_token_hash: confirmTokenHash,
        via_late_access: options.viaLateAccess,
      },
      ctx,
    );

    if (options.viaLateAccess) {
      const confirmed = await appendBookingEventWithEffects(
        booking.id,
        'EMAIL_CONFIRMED',
        'system',
        { reason: 'late_access_booking' },
        ctx,
      );
      return { bookingId: confirmed.booking.id, status: confirmed.booking.current_status };
    }

    return { bookingId: created.booking.id, status: created.booking.current_status };
  }

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    'BOOKING_FORM_SUBMITTED_PAY_NOW',
    'public_ui',
    {
      payment_mode: 'pay_now',
      event_id: input.event.id,
    },
    ctx,
  );

  const checkout = await ensureCheckoutForBooking(
    transitioned.booking,
    {
      title: input.event.title,
      price: input.event.price_per_person_cents ?? 0,
      currency: input.event.currency,
    },
    ctx,
  );

  await markCheckoutSideEffectAttempt(transitioned.sideEffects, checkout.effectApiLogId, 'success', null, ctx);

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

  if (booking.current_status !== 'PENDING_CONFIRMATION') {
    if (booking.current_status === 'SLOT_CONFIRMED' || booking.current_status === 'PAID') {
      return booking;
    }
    throw gone('This confirmation link is no longer valid');
  }

  const transitioned = await appendBookingEventWithEffects(
    booking.id,
    'EMAIL_CONFIRMED',
    'public_ui',
    { token_hash: tokenHash },
    ctx,
  );

  return applyImmediateReservationForTransition({
    transitionEventType: 'EMAIL_CONFIRMED',
    sourceOperation: 'confirm_booking_email',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, ctx);
}

// ── Payment success (webhook/dev) ──────────────────────────────────────────

export async function confirmBookingPayment(
  payment: { id: string; booking_id: string; provider_payment_id: string | null },
  stripeData: { paymentIntentId: string | null; invoiceId: string | null; invoiceUrl: string | null },
  ctx: BookingContext,
): Promise<void> {
  const { providers, logger } = ctx;

  await providers.repository.updatePayment(payment.id, {
    status: 'succeeded',
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

  if (isTerminalStatus(booking.current_status)) {
    logger.warn('Late payment for inactive booking — not reviving', {
      bookingId: booking.id,
      current_status: booking.current_status,
    });

    await providers.repository.createBookingEvent({
      booking_id: booking.id,
      event_type: 'PAYMENT_SETTLED',
      source: 'webhook',
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
    'webhook',
    {
      payment_intent_id: stripeData.paymentIntentId,
      invoice_id: stripeData.invoiceId,
      invoice_url: stripeData.invoiceUrl,
    },
    ctx,
  );

  await applyImmediateReservationForTransition({
    transitionEventType: 'PAYMENT_SETTLED',
    sourceOperation: 'confirm_booking_payment',
    bookingBeforeTransition: booking,
    bookingAfterTransition: transitioned.booking,
    transitionSideEffects: transitioned.sideEffects,
  }, ctx);
}

// ── Manage-token resolution ────────────────────────────────────────────────

export async function resolveBookingByManageToken(
  rawToken: string,
  repository: Providers['repository'],
): Promise<Booking> {
  const parsed = parseStableManageToken(rawToken);
  const bookingId = parsed?.bookingId ?? rawToken;

  const booking = await repository.getBookingById(bookingId);
  if (!booking) throw notFound('Booking not found');
  return booking;
}

export async function cancelBooking(
  booking: Booking,
  ctx: BookingContext,
): Promise<void> {
  if (isTerminalStatus(booking.current_status)) {
    throw badRequest('Booking cannot be cancelled in its current state');
  }

  await appendBookingEventWithEffects(
    booking.id,
    'BOOKING_CANCELED',
    'public_ui',
    { reason: 'user_cancelled' },
    ctx,
  );
}

export async function expireBooking(
  booking: Booking,
  ctx: BookingContext,
): Promise<Booking> {
  const result = await appendBookingEventWithEffects(
    booking.id,
    'BOOKING_EXPIRED',
    'job',
    { reason: 'side_effect_expired' },
    ctx,
  );
  return result.booking;
}

export async function rescheduleBooking(
  booking: Booking,
  input: RescheduleInput,
  ctx: BookingContext,
): Promise<Booking> {
  if (booking.event_id) {
    throw badRequest('Only 1:1 bookings can be rescheduled');
  }

  if (isTerminalStatus(booking.current_status)) {
    throw badRequest('Booking cannot be rescheduled in its current state');
  }

  await assertSlotAvailable(input.newStart, input.newEnd, ctx.providers, {
    ignoreInterval: { start: booking.starts_at, end: booking.ends_at },
  });

  const updated = await ctx.providers.repository.updateBooking(booking.id, {
    starts_at: input.newStart,
    ends_at: input.newEnd,
    timezone: input.timezone,
  });

  await appendBookingEventWithEffects(
    booking.id,
    'BOOKING_RESCHEDULED',
    'public_ui',
    {
      from: { start: booking.starts_at, end: booking.ends_at, timezone: booking.timezone },
      to: { start: updated.starts_at, end: updated.ends_at, timezone: updated.timezone },
    },
    ctx,
  );

  return updated;
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
  if (booking.current_status !== 'PENDING_CONFIRMATION') return;

  const events = await ctx.providers.repository.listBookingEvents(booking.id);
  const latestSubmitted = [...events]
    .reverse()
    .find((event) =>
      event.event_type === 'BOOKING_FORM_SUBMITTED_FREE' ||
      event.event_type === 'BOOKING_FORM_SUBMITTED_PAY_LATER',
    );

  const confirmToken = typeof latestSubmitted?.payload?.['confirm_token'] === 'string'
    ? latestSubmitted.payload['confirm_token'] as string
    : null;

  if (!confirmToken) return;

  const confirmUrl = buildConfirmUrl(ctx.env.SITE_URL, confirmToken);
  await sendEmailConfirmation(booking, confirmUrl, ctx);
  await ctx.providers.repository.createBookingEvent({
    booking_id: booking.id,
    event_type: 'SLOT_RESERVATION_REMINDER_SENT',
    source: 'job',
    payload: { reason: 'followup' },
  });
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

  await ctx.providers.repository.createBookingEvent({
    booking_id: booking.id,
    event_type: 'DATE_REMINDER_SENT',
    source: 'job',
    payload: {},
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
    payment && payment.status === 'pending' && !isTerminalStatus(booking.current_status)
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
  if (event.status !== 'published') throw badRequest('Event is not open for booking');
  const nowMs = Date.now();
  const cutoffMs = new Date(event.starts_at).getTime() + PUBLIC_EVENT_CUTOFF_AFTER_START_MINUTES * 60_000;
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

async function sendEmailConfirmation(booking: Booking, confirmUrl: string, ctx: BookingContext): Promise<void> {
  if (!booking.event_id) {
    await ctx.providers.email.sendBookingConfirmRequest(booking, confirmUrl);
    return;
  }

  const event = await ctx.providers.repository.getEventById(booking.event_id);
  if (!event) return;
  await ctx.providers.email.sendEventConfirmRequest(booking, event, confirmUrl);
}

function shouldSessionBookingHaveCalendarEvent(booking: Booking): boolean {
  if (booking.event_id) return false;
  return booking.current_status === 'SLOT_CONFIRMED' || booking.current_status === 'PAID';
}

function fullClientName(booking: Booking): string {
  return [booking.client_first_name ?? '', booking.client_last_name ?? ''].join(' ').trim() || 'Unknown Client';
}

function buildSessionCalendarEventPayload(booking: Booking): CalendarEvent {
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
  const payload = buildSessionCalendarEventPayload(booking);

  if (!needsEvent) {
    if (!booking.google_event_id) {
      return { booking, calendarSynced: true, failureReason: null };
    }

    try {
      await providers.calendar.deleteEvent(booking.google_event_id);
      const updated = await providers.repository.updateBooking(booking.id, { google_event_id: null });
      return { booking: updated, calendarSynced: true, failureReason: null };
    } catch (error) {
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

function reservationSkipReason(
  eventType: BookingEventType,
  bookingBeforeTransition: Booking,
  bookingAfterTransition: Booking,
): string {
  if (bookingAfterTransition.event_id) return 'event_booking';
  if (bookingBeforeTransition.current_status === bookingAfterTransition.current_status) return 'no_status_transition';
  const reservableBefore = bookingBeforeTransition.current_status === 'SLOT_CONFIRMED' || bookingBeforeTransition.current_status === 'PAID';
  const reservableAfter = bookingAfterTransition.current_status === 'SLOT_CONFIRMED' || bookingAfterTransition.current_status === 'PAID';
  if (!reservableAfter) return 'target_status_not_reservable';
  if (reservableBefore) return 'already_reservable_before_transition';
  return `event_not_reservation_trigger:${eventType}`;
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
  const reservationEffects = input.transitionSideEffects.filter((effect) => effect.effect_intent === 'reserve_slot');

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

  if (!shouldReserveNow) return input.bookingAfterTransition;

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
        deny_reason: 'no_reserve_slot_side_effect',
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
      'fail',
      failureReason,
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

    return syncResult.booking;
  }

  await markSideEffectAttemptForEffects(
    reservationEffects,
    'success',
    null,
    ctx,
  );

  let finalBooking = syncResult.booking;
  let slotConfirmedEventWritten = false;

  if (!['EXPIRED', 'CANCELED', 'CLOSED'].includes(finalBooking.current_status)) {
    const slotConfirmed = await appendBookingEventWithEffects(
      finalBooking.id,
      'SLOT_CONFIRMED',
      'system',
      {
        source_operation: input.sourceOperation,
        transition_event_type: input.transitionEventType,
        via: 'immediate_calendar_reservation',
      },
      ctx,
    );
    finalBooking = slotConfirmed.booking;
    slotConfirmedEventWritten = true;
  }

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
      slot_confirmed_event_written: slotConfirmedEventWritten,
      branch_taken: 'side_effect_succeeded_immediate_reservation',
    },
  });

  return finalBooking;
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

async function ensureCheckoutForBooking(
  booking: Booking,
  chargeable: Pick<SessionTypeRecord, 'title' | 'price' | 'currency'>,
  ctx: BookingContext,
): Promise<{ checkoutUrl: string; expiresAt: string; effectApiLogId: string }> {
  const existing = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  if (existing?.checkout_url) {
    const event = await ctx.providers.repository.getLatestBookingEvent(booking.id);
    const fallbackExpiry = event ? new Date(new Date(event.created_at).getTime() + 45 * 60_000).toISOString() : new Date(Date.now() + 45 * 60_000).toISOString();
    return {
      checkoutUrl: existing.checkout_url,
      expiresAt: fallbackExpiry,
      effectApiLogId: crypto.randomUUID(),
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
    status: 'pending',
    checkout_url: session.checkoutUrl,
    invoice_url: null,
    raw_payload: null,
    paid_at: null,
  });

  const latestEvent = await ctx.providers.repository.getLatestBookingEvent(booking.id);
  const expiresAt = latestEvent
    ? new Date(new Date(latestEvent.created_at).getTime() + 45 * 60_000).toISOString()
    : new Date(Date.now() + 45 * 60_000).toISOString();

  return {
    checkoutUrl: session.checkoutUrl,
    expiresAt,
    effectApiLogId: crypto.randomUUID(),
  };
}

async function markCheckoutSideEffectAttempt(
  effects: Array<{ id: string; effect_intent: string; max_attempts: number }>,
  apiLogId: string,
  status: 'success' | 'fail',
  errorMessage: string | null,
  ctx: BookingContext,
): Promise<void> {
  const checkoutEffect = effects.find((effect) => effect.effect_intent === 'create_stripe_checkout');
  if (!checkoutEffect) return;

  const lastAttempt = await ctx.providers.repository.getLastBookingSideEffectAttempt(checkoutEffect.id);
  const attemptNum = (lastAttempt?.attempt_num ?? 0) + 1;

  await ctx.providers.repository.createBookingSideEffectAttempt({
    booking_side_effect_id: checkoutEffect.id,
    attempt_num: attemptNum,
    api_log_id: apiLogId,
    status,
    error_message: errorMessage,
  });

  if (status === 'success') {
    await ctx.providers.repository.updateBookingSideEffect(checkoutEffect.id, { status: 'success' });
    return;
  }

  const nextStatus = attemptNum >= checkoutEffect.max_attempts ? 'dead' : 'failed';
  await ctx.providers.repository.updateBookingSideEffect(checkoutEffect.id, { status: nextStatus });
}

async function markSideEffectAttemptForEffects(
  effects: Array<Pick<BookingSideEffect, 'id' | 'max_attempts'>>,
  status: 'success' | 'fail',
  errorMessage: string | null,
  ctx: BookingContext,
): Promise<void> {
  for (const effect of effects) {
    const lastAttempt = await ctx.providers.repository.getLastBookingSideEffectAttempt(effect.id);
    const attemptNum = (lastAttempt?.attempt_num ?? 0) + 1;
    await ctx.providers.repository.createBookingSideEffectAttempt({
      booking_side_effect_id: effect.id,
      attempt_num: attemptNum,
      api_log_id: crypto.randomUUID(),
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
      status: 'processing',
      updated_at: updatedAt,
    });
  }
}
