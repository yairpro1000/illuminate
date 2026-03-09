import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { Booking, Event } from '../types.js';
import type { CalendarEvent } from '../providers/calendar/interface.js';
import { generateToken, hashToken, hashesEqual } from './token-service.js';
import { computePaymentDueReminderTime, compute24hReminderTime } from './reminder-service.js';
import { badRequest, conflict, gone, notFound } from '../lib/errors.js';
import { syncStateFromLegacy, setLifecycle, recordEvent } from './booking-transition.js';

const CALENDAR_SYNC_MAX_ATTEMPTS = 5;
const CHECKOUT_HOLD_MINUTES = 15;
const BOOKING_CONFIRM_WINDOW_MINUTES = 60;
const EVENT_CONFIRM_WINDOW_MINUTES = 15;
const FOLLOWUP_DELAY_HOURS = 2;
const PUBLIC_EVENT_CUTOFF_AFTER_START_MINUTES = 30;

export interface BookingContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
}

// ── Session booking inputs ──────────────────────────────────────────────────

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
  status: 'pending_email';
}

// ── Event booking inputs ────────────────────────────────────────────────────

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
  status: Booking['status'];
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
}

export interface BookingPublicActionInfo {
  booking: Booking;
  checkoutUrl: string | null;
  manageUrl: string | null;
  nextActionUrl: string | null;
  nextActionLabel: 'Complete Payment' | 'Manage Booking' | null;
}

// ── Session flow: Pay Now ───────────────────────────────────────────────────

export async function createPayNowBooking(
  input: PayNowInput,
  ctx: BookingContext,
): Promise<PayNowResult> {
  const { providers, env, logger } = ctx;

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

  const manageTokenHash = await hashToken(generateToken());
  const holdExpiresAt = new Date(Date.now() + CHECKOUT_HOLD_MINUTES * 60_000).toISOString();

  const booking = await providers.repository.createBooking({
    client_id: client.id,
    source: 'session',
    status: 'pending_payment',
    event_id: null,
    session_type: input.sessionType,
    starts_at: input.slotStart,
    ends_at: input.slotEnd,
    timezone: input.timezone,
    address_line: env.SESSION_ADDRESS,
    maps_url: env.SESSION_MAPS_URL,
    attended: false,
    notes: null,
    confirm_token_hash: null,
    confirm_expires_at: null,
    manage_token_hash: manageTokenHash,
    checkout_session_id: null,
    checkout_hold_expires_at: holdExpiresAt,
    payment_due_at: null,
    payment_due_reminder_scheduled_at: null,
    payment_due_reminder_sent_at: null,
    followup_scheduled_at: null,
    followup_sent_at: null,
    reminder_email_opt_in: input.reminderEmailOptIn,
    reminder_whatsapp_opt_in: input.reminderWhatsappOptIn,
    reminder_24h_scheduled_at: null,
    reminder_24h_sent_at: null,
    google_event_id: null,
  });

  const amountCents = input.sessionType === 'session' ? 18000 : 0;
  const session = await providers.payments.createCheckoutSession({
    lineItems: [{
      name: `ILLUMINATE 1:1 ${input.sessionType === 'session' ? 'Session' : 'Intro'}`,
      amountCents,
      currency: 'CHF',
      quantity: 1,
    }],
    bookingId: booking.id,
    successUrl: `${env.SITE_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${env.SITE_URL}/payment-cancel.html?session_id={CHECKOUT_SESSION_ID}`,
  });

  await providers.repository.updateBooking(booking.id, {
    checkout_session_id: session.sessionId,
  });

  await providers.repository.createPayment({
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

  logger.info('pay-now booking created', { bookingId: booking.id, clientId: client.id });

  // Record domain event + sync new lifecycle fields
  try {
    await recordEvent(ctx, booking.id, 'BOOKING_CREATED', 'ui', { payment_mode: 'pay_now' });
    await ctx.providers.repository.updateBooking(booking.id, { hold_expires_at: holdExpiresAt });
    await syncStateFromLegacy(booking, ctx, 'ui', 'BOOKING_CREATED', { payment_mode: 'pay_now' });
  } catch (err) {
    logger.warn?.('state-sync failure after createPayNowBooking', { bookingId: booking.id, err: String(err) });
  }

  return {
    bookingId: booking.id,
    checkoutUrl: session.checkoutUrl,
    checkoutHoldExpiresAt: holdExpiresAt,
  };
}

// ── Session flow: Pay Later ─────────────────────────────────────────────────

export async function createPayLaterBooking(
  input: PayLaterInput,
  ctx: BookingContext,
): Promise<PayLaterResult> {
  const { providers, env, logger } = ctx;

  await providers.antibot.verify(input.turnstileToken, input.remoteIp);
  await assertSlotAvailable(input.slotStart, input.slotEnd, providers);

  const { firstName, lastName } = splitFullName(input.clientName);
  const client = await upsertClient(
    { firstName, lastName, email: input.clientEmail, phone: input.clientPhone },
    providers,
  );

  const confirmToken = generateToken();
  const confirmTokenHash = await hashToken(confirmToken);
  const manageTokenHash = await hashToken(generateToken());

  const confirmExpiresAt = new Date(Date.now() + BOOKING_CONFIRM_WINDOW_MINUTES * 60_000).toISOString();
  const holdExpiresAt = new Date(Date.now() + BOOKING_CONFIRM_WINDOW_MINUTES * 60_000).toISOString();
  const followupScheduledAt = new Date(Date.now() + FOLLOWUP_DELAY_HOURS * 60 * 60_000).toISOString();

  const booking = await providers.repository.createBooking({
    client_id: client.id,
    source: 'session',
    status: 'pending_email',
    event_id: null,
    session_type: input.sessionType,
    starts_at: input.slotStart,
    ends_at: input.slotEnd,
    timezone: input.timezone,
    address_line: env.SESSION_ADDRESS,
    maps_url: env.SESSION_MAPS_URL,
    attended: false,
    notes: null,
    confirm_token_hash: confirmTokenHash,
    confirm_expires_at: confirmExpiresAt,
    manage_token_hash: manageTokenHash,
    checkout_session_id: null,
    checkout_hold_expires_at: holdExpiresAt,
    hold_expires_at: holdExpiresAt,
    payment_due_at: null,
    payment_due_reminder_scheduled_at: null,
    payment_due_reminder_sent_at: null,
    followup_scheduled_at: followupScheduledAt,
    followup_sent_at: null,
    reminder_email_opt_in: input.reminderEmailOptIn,
    reminder_whatsapp_opt_in: input.reminderWhatsappOptIn,
    reminder_24h_scheduled_at: null,
    reminder_24h_sent_at: null,
    google_event_id: null,
  });

  const confirmUrl = buildConfirmUrl(env.SITE_URL, confirmToken);
  await providers.repository.enqueueSideEffect({
    booking_id: booking.id,
    effect_type: 'email.confirm_request.session',
    payload: { confirm_url: confirmUrl },
  });

  logger.info('pay-later booking created', { bookingId: booking.id, clientId: client.id });
  try {
    await recordEvent(ctx, booking.id, 'BOOKING_CREATED', 'ui', { payment_mode: 'pay_later' });
    await syncStateFromLegacy(booking, ctx, 'ui', 'BOOKING_CREATED', { payment_mode: 'pay_later' });
  } catch (err) {
    logger.warn?.('state-sync failure after createPayLaterBooking', { bookingId: booking.id, err: String(err) });
  }
  return { bookingId: booking.id, status: 'pending_email' };
}

// ── Event flow: normal booking ──────────────────────────────────────────────

export async function createEventBooking(
  input: EventBookingInput,
  ctx: BookingContext,
): Promise<EventBookingResult> {
  await ensureEventPublicBookable(input.event);
  return createEventBookingInternal(input, ctx, { viaLateAccess: false });
}

// ── Event flow: late-access booking ─────────────────────────────────────────

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
  const { providers, env } = ctx;

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

  const manageTokenHash = await hashToken(generateToken());
  const followupScheduledAt = new Date(Date.now() + FOLLOWUP_DELAY_HOURS * 60 * 60_000).toISOString();

  // Free events require email confirmation unless booked via late-access.
  if (!input.event.is_paid) {
    const confirmToken = options.viaLateAccess ? null : generateToken();
    const confirmTokenHash = confirmToken ? await hashToken(confirmToken) : null;

    const booking = await providers.repository.createBooking({
      client_id: client.id,
      source: 'event',
      status: options.viaLateAccess ? 'confirmed' : 'pending_email',
      event_id: input.event.id,
      session_type: null,
      starts_at: input.event.starts_at,
      ends_at: input.event.ends_at,
      timezone: input.event.timezone,
      address_line: input.event.address_line,
      maps_url: input.event.maps_url,
      attended: false,
      notes: null,
      confirm_token_hash: confirmTokenHash,
      confirm_expires_at: confirmToken
        ? new Date(Date.now() + EVENT_CONFIRM_WINDOW_MINUTES * 60_000).toISOString()
        : null,
      manage_token_hash: manageTokenHash,
      checkout_session_id: null,
      checkout_hold_expires_at: null,
      payment_due_at: null,
      payment_due_reminder_scheduled_at: null,
      payment_due_reminder_sent_at: null,
      followup_scheduled_at: options.viaLateAccess ? null : followupScheduledAt,
      followup_sent_at: null,
      reminder_email_opt_in: input.reminderEmailOptIn,
      reminder_whatsapp_opt_in: input.reminderWhatsappOptIn,
      reminder_24h_scheduled_at: input.reminderEmailOptIn
        ? (compute24hReminderTime(new Date(input.event.starts_at))?.toISOString() ?? null)
        : null,
      reminder_24h_sent_at: null,
      google_event_id: null,
    });

    if (options.viaLateAccess) {
      const manageUrl = await buildManageUrl(env.SITE_URL, booking);
      await providers.email.sendEventConfirmation(booking, input.event, manageUrl, null);
      return { bookingId: booking.id, status: 'confirmed' };
    }

    const confirmUrl = buildConfirmUrl(env.SITE_URL, confirmToken!);
    await providers.email.sendEventConfirmRequest(booking, input.event, confirmUrl);
    return { bookingId: booking.id, status: 'pending_email' };
  }

  // Paid events always use pending_payment + checkout hold.
  const holdExpiresAt = new Date(Date.now() + CHECKOUT_HOLD_MINUTES * 60_000).toISOString();
  const booking = await providers.repository.createBooking({
    client_id: client.id,
    source: 'event',
    status: 'pending_payment',
    event_id: input.event.id,
    session_type: null,
    starts_at: input.event.starts_at,
    ends_at: input.event.ends_at,
    timezone: input.event.timezone,
    address_line: input.event.address_line,
    maps_url: input.event.maps_url,
    attended: false,
    notes: null,
    confirm_token_hash: null,
    confirm_expires_at: null,
    manage_token_hash: manageTokenHash,
    checkout_session_id: null,
    checkout_hold_expires_at: holdExpiresAt,
    payment_due_at: null,
    payment_due_reminder_scheduled_at: null,
    payment_due_reminder_sent_at: null,
    followup_scheduled_at: null,
    followup_sent_at: null,
    reminder_email_opt_in: input.reminderEmailOptIn,
    reminder_whatsapp_opt_in: input.reminderWhatsappOptIn,
    reminder_24h_scheduled_at: null,
    reminder_24h_sent_at: null,
    google_event_id: null,
  });

  const session = await providers.payments.createCheckoutSession({
    lineItems: [{
      name: `${input.event.title} — ILLUMINATE`,
      amountCents: input.event.price_per_person_cents ?? 0,
      currency: input.event.currency,
      quantity: 1,
    }],
    bookingId: booking.id,
    successUrl: `${env.SITE_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${env.SITE_URL}/payment-cancel.html?session_id={CHECKOUT_SESSION_ID}`,
  });

  await providers.repository.updateBooking(booking.id, {
    checkout_session_id: session.sessionId,
  });

  await providers.repository.createPayment({
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

  return {
    bookingId: booking.id,
    status: 'pending_payment',
    checkoutUrl: session.checkoutUrl,
    checkoutHoldExpiresAt: holdExpiresAt,
  };
}

// ── Confirm email token ─────────────────────────────────────────────────────

export async function confirmBookingEmail(
  rawToken: string,
  ctx: BookingContext,
): Promise<Booking> {
  const { providers, env } = ctx;

  const tokenHash = await hashToken(rawToken);
  const booking = await providers.repository.getBookingByConfirmTokenHash(tokenHash);
  if (!booking) throw notFound('Booking not found');

  if (booking.status !== 'pending_email') {
    if (booking.source === 'session' && ['pending_payment', 'confirmed', 'cash_ok'].includes(booking.status)) {
      return ensureSessionRecoveryState(booking, ctx);
    }
    if (booking.source === 'event' && booking.status === 'confirmed') {
      return booking;
    }
    throw gone('This confirmation link is no longer valid');
  }

  if (booking.confirm_expires_at && new Date(booking.confirm_expires_at) < new Date()) {
    throw gone('This confirmation link has expired');
  }

  if (booking.source === 'session') {
    if (booking.session_type === 'intro') {
      const reminder24h = compute24hReminderTime(new Date(booking.starts_at));

      let updated = await providers.repository.updateBooking(booking.id, {
        status: 'confirmed',
        confirm_expires_at: null,
        reminder_24h_scheduled_at: booking.reminder_email_opt_in ? reminder24h?.toISOString() ?? null : null,
      });

      updated = (await syncSessionBookingCalendar(updated, ctx, {
        operation: 'confirm_email_intro',
        forceUpdate: true,
      })).booking;

      await ctx.providers.repository.enqueueSideEffect({
        booking_id: updated.id,
        effect_type: 'email.confirmed.session',
        payload: { invoice_url: null },
      });
      try {
        updated = await setLifecycle(updated, {
          booking_status: 'confirmed',
          payment_mode: 'free',
          payment_status_v2: 'not_required',
          email_status: 'confirmed',
          slot_status: 'reserved',
          confirmed_at: new Date().toISOString(),
          email_confirmed_at: new Date().toISOString(),
        }, ctx, 'ui', 'EMAIL_CONFIRMED');
      } catch {}
      return updated;
    }

    const startsAt = new Date(booking.starts_at);
    const paymentDueAt = new Date(startsAt.getTime() - 24 * 60 * 60 * 1000);
    const reminderTime = computePaymentDueReminderTime(paymentDueAt, booking.timezone);
    const reminder24h = compute24hReminderTime(startsAt);

    let updated = await providers.repository.updateBooking(booking.id, {
      status: 'pending_payment',
      confirm_expires_at: null,
      payment_due_at: paymentDueAt.toISOString(),
      payment_due_reminder_scheduled_at: reminderTime.toISOString(),
      reminder_24h_scheduled_at: reminder24h?.toISOString() ?? null,
    });

    updated = (await syncSessionBookingCalendar(updated, ctx, { operation: 'confirm_email' })).booking;

    const ensured = await ensureSessionCheckout(updated, ctx);
    await ctx.providers.repository.enqueueSideEffect({
      booking_id: ensured.booking.id,
      effect_type: 'email.payment_due.session',
      payload: {},
    });
    try {
      updated = await setLifecycle(ensured.booking, {
        booking_status: 'confirmed',
        payment_mode: 'pay_later',
        payment_status_v2: 'pending',
        email_status: 'confirmed',
        slot_status: 'reserved',
        payment_due_at: paymentDueAt.toISOString(),
      }, ctx, 'ui', 'EMAIL_CONFIRMED');
    } catch {}
    return updated;
  }

  const event = booking.event_id ? await providers.repository.getEventById(booking.event_id) : null;
  if (!event) throw notFound('Event not found');

  const reminder24h = compute24hReminderTime(new Date(event.starts_at));
  const updated = await providers.repository.updateBooking(booking.id, {
    status: 'confirmed',
    confirm_expires_at: null,
    reminder_24h_scheduled_at: booking.reminder_email_opt_in ? reminder24h?.toISOString() ?? null : null,
  });

  await ctx.providers.repository.enqueueSideEffect({
    booking_id: updated.id,
    effect_type: 'email.confirmed.event',
    payload: { invoice_url: null },
  });
  try {
    await setLifecycle(updated, {
      booking_status: 'confirmed',
      payment_mode: 'free',
      payment_status_v2: 'not_required',
      email_status: 'confirmed',
      slot_status: 'reserved',
      confirmed_at: new Date().toISOString(),
      email_confirmed_at: new Date().toISOString(),
    }, ctx, 'ui', 'EMAIL_CONFIRMED', { event_id: booking.event_id });
  } catch {}
  return updated;
}

// ── Payment success (webhook/dev) ───────────────────────────────────────────

export async function confirmBookingPayment(
  payment: { id: string; booking_id: string; provider_payment_id: string | null },
  stripeData: { paymentIntentId: string | null; invoiceId: string | null; invoiceUrl: string | null },
  ctx: BookingContext,
): Promise<void> {
  const { providers, env, logger } = ctx;

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

  if (booking.status === 'confirmed' || booking.status === 'cash_ok') {
    logger.info('booking payment already confirmed (idempotent)', { bookingId: booking.id });
    return;
  }

  // New rule: do not revive expired/cancelled bookings on late payment
  if (booking.status === 'expired' || booking.status === 'cancelled') {
    logger.warn('Late payment for inactive booking — not reviving', { bookingId: booking.id, status: booking.status });
    await recordEvent(ctx, booking.id, 'PAYMENT_SUCCEEDED', 'webhook', {
      late: true,
      prior_status: booking.status,
      payment_intent_id: stripeData.paymentIntentId,
      invoice_id: stripeData.invoiceId,
    });
    return;
  }

  if (booking.source === 'session') {
    const reminder24h = compute24hReminderTime(new Date(booking.starts_at));

    let updated = await providers.repository.updateBooking(booking.id, {
      status: 'confirmed',
      checkout_hold_expires_at: null,
      reminder_24h_scheduled_at: booking.reminder_24h_scheduled_at ?? reminder24h?.toISOString() ?? null,
    });

    updated = (await syncSessionBookingCalendar(updated, ctx, {
      operation: 'payment_confirmed',
      forceUpdate: true,
    })).booking;

    await ctx.providers.repository.enqueueSideEffect({
      booking_id: updated.id,
      effect_type: 'email.confirmed.session',
      payload: { invoice_url: stripeData.invoiceUrl },
    });
    try {
      await setLifecycle(updated, {
        booking_status: 'confirmed',
        payment_mode: 'pay_now',
        payment_status_v2: 'paid',
        email_status: 'not_required',
        slot_status: 'reserved',
        hold_expires_at: null,
        confirmed_at: new Date().toISOString(),
      }, ctx, 'webhook', 'PAYMENT_SUCCEEDED', { invoice_url: stripeData.invoiceUrl });
    } catch {}
    return;
  }

  const event = booking.event_id ? await providers.repository.getEventById(booking.event_id) : null;
  if (!event) throw notFound('Event not found');

  const reminder24h = compute24hReminderTime(new Date(event.starts_at));

  const updated = await providers.repository.updateBooking(booking.id, {
    status: 'confirmed',
    checkout_hold_expires_at: null,
    reminder_24h_scheduled_at: booking.reminder_email_opt_in ? reminder24h?.toISOString() ?? null : null,
  });

  await ctx.providers.repository.enqueueSideEffect({
    booking_id: updated.id,
    effect_type: 'email.confirmed.event',
    payload: { invoice_url: stripeData.invoiceUrl },
  });
  try {
    await setLifecycle(updated, {
      booking_status: 'confirmed',
      payment_mode: 'pay_now',
      payment_status_v2: 'paid',
      email_status: 'not_required',
      slot_status: 'reserved',
      hold_expires_at: null,
      confirmed_at: new Date().toISOString(),
    }, ctx, 'webhook', 'PAYMENT_SUCCEEDED', { invoice_url: stripeData.invoiceUrl, event_id: event.id });
  } catch {}
}

// ── Manage-token resolution ─────────────────────────────────────────────────

export async function resolveBookingByManageToken(
  rawToken: string,
  repository: Providers['repository'],
): Promise<Booking> {
  const stableToken = parseStableManageToken(rawToken);
  if (stableToken) {
    const booking = await repository.getBookingById(stableToken.bookingId);
    if (!booking) throw notFound('Booking not found');

    const expectedSignature = await buildStableManageSignature(booking.id, booking.manage_token_hash);
    if (!hashesEqual(expectedSignature, stableToken.signature)) {
      throw notFound('Booking not found');
    }
    return booking;
  }

  const tokenHash = await hashToken(rawToken);
  const booking = await repository.getBookingByManageTokenHash(tokenHash);
  if (!booking) throw notFound('Booking not found');

  if (!hashesEqual(tokenHash, booking.manage_token_hash)) {
    throw notFound('Booking not found');
  }

  return booking;
}

export async function cancelBooking(
  booking: Booking,
  ctx: BookingContext,
): Promise<void> {
  const cancellable: Booking['status'][] = ['pending_email', 'pending_payment', 'confirmed', 'cash_ok'];
  if (!cancellable.includes(booking.status)) {
    throw badRequest('Booking cannot be cancelled in its current state');
  }

  let updated = await ctx.providers.repository.updateBooking(booking.id, { status: 'cancelled' });
  updated = (await syncSessionBookingCalendar(updated, ctx, { operation: 'cancel_booking' })).booking;

  if (updated.source === 'session') {
    await ctx.providers.repository.enqueueSideEffect({
      booking_id: updated.id,
      effect_type: 'email.cancellation.session',
      payload: {},
    });
  }
  try {
    await setLifecycle(updated, {
      booking_status: 'cancelled',
      slot_status: 'released',
      cancelled_at: new Date().toISOString(),
      cancel_reason: 'user_cancelled',
    }, ctx, 'ui', 'USER_CANCELLED');
  } catch {}
}

export async function expireBooking(
  booking: Booking,
  ctx: BookingContext,
): Promise<Booking> {
  let updated = await ctx.providers.repository.updateBooking(booking.id, {
    status: 'expired',
    checkout_hold_expires_at: null,
  });
  updated = (await syncSessionBookingCalendar(updated, ctx, { operation: 'expire_booking' })).booking;
  try {
    updated = await setLifecycle(updated, {
      booking_status: 'expired',
      slot_status: 'released',
      expired_at: new Date().toISOString(),
      expired_reason: updated.status === 'pending_payment' ? 'payment_timeout' : 'email_confirmation_timeout',
      hold_expires_at: null,
    }, ctx, 'cron', 'HOLD_EXPIRED');
  } catch {}
  return updated;
}

export async function rescheduleBooking(
  booking: Booking,
  input: RescheduleInput,
  ctx: BookingContext,
): Promise<Booking> {
  if (booking.source !== 'session') {
    throw badRequest('Only 1:1 bookings can be rescheduled');
  }

  if (!['pending_payment', 'confirmed', 'cash_ok'].includes(booking.status)) {
    throw badRequest('Booking cannot be rescheduled in its current state');
  }

  await assertSlotAvailable(input.newStart, input.newEnd, ctx.providers, {
    ignoreInterval: { start: booking.starts_at, end: booking.ends_at },
  });

  let updated = await ctx.providers.repository.updateBooking(booking.id, {
    starts_at: input.newStart,
    ends_at: input.newEnd,
    timezone: input.timezone,
  });

  updated = (await syncSessionBookingCalendar(updated, ctx, {
    operation: 'reschedule_booking',
    forceUpdate: true,
  })).booking;
  try {
    await recordEvent(ctx, updated.id, 'USER_RESCHEDULED', 'ui', { from: { start: booking.starts_at, end: booking.ends_at }, to: { start: updated.starts_at, end: updated.ends_at } });
  } catch {}
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
  const { providers, env } = ctx;

  if (booking.source === 'session') {
    const confirmToken = generateToken();
    const confirmTokenHash = await hashToken(confirmToken);
    const updated = await providers.repository.updateBooking(booking.id, {
      confirm_token_hash: confirmTokenHash,
      confirm_expires_at: new Date(Date.now() + BOOKING_CONFIRM_WINDOW_MINUTES * 60_000).toISOString(),
    });
    const confirmUrl = buildConfirmUrl(env.SITE_URL, confirmToken);
    await providers.email.sendBookingFollowup(updated, confirmUrl);
    await providers.repository.updateBooking(updated.id, { followup_sent_at: new Date().toISOString() });
    return;
  }

  const event = booking.event_id ? await providers.repository.getEventById(booking.event_id) : null;
  if (!event) return;

  if (booking.status !== 'pending_email') return;

  const confirmToken = generateToken();
  const confirmTokenHash = await hashToken(confirmToken);
  const updated = await providers.repository.updateBooking(booking.id, {
    confirm_token_hash: confirmTokenHash,
    confirm_expires_at: new Date(Date.now() + EVENT_CONFIRM_WINDOW_MINUTES * 60_000).toISOString(),
  });
  const confirmUrl = buildConfirmUrl(env.SITE_URL, confirmToken);
  await providers.email.sendEventFollowup(updated, event, confirmUrl);

  await providers.repository.updateBooking(booking.id, { followup_sent_at: new Date().toISOString() });
}

export async function send24hBookingReminder(booking: Booking, ctx: BookingContext): Promise<void> {
  const { providers, env } = ctx;
  const manageUrl = await buildManageUrl(env.SITE_URL, booking);

  if (booking.source === 'session') {
    await providers.email.sendBookingReminder24h(booking, manageUrl);
    await providers.repository.updateBooking(booking.id, { reminder_24h_sent_at: new Date().toISOString() });
    return;
  }

  const event = booking.event_id ? await providers.repository.getEventById(booking.event_id) : null;
  if (!event) return;
  await providers.email.sendEventReminder24h(booking, event, manageUrl);
  await providers.repository.updateBooking(booking.id, { reminder_24h_sent_at: new Date().toISOString() });
}

export async function getBookingPublicActionInfo(
  booking: Booking,
  ctx: BookingContext,
): Promise<BookingPublicActionInfo> {
  const manageUrl = ['pending_payment', 'confirmed', 'cash_ok'].includes(booking.status)
    ? await buildManageUrl(ctx.env.SITE_URL, booking)
    : null;
  const checkoutUrl = booking.status === 'pending_payment'
    ? await getCheckoutUrlForBooking(booking.id, ctx.providers.repository)
    : null;

  if (booking.status === 'pending_payment' && checkoutUrl) {
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

// ── Internal helpers ────────────────────────────────────────────────────────

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
    const bStart = new Date(busy.start).getTime();
    const bEnd = new Date(busy.end).getTime();
    if (ignoreStartMs !== null && ignoreEndMs !== null && bStart === ignoreStartMs && bEnd === ignoreEndMs) {
      continue;
    }
    if (startMs < bEnd && endMs > bStart) {
      throw conflict('This slot is no longer available');
    }
  }
}

function shouldSessionBookingHaveCalendarEvent(booking: Booking): boolean {
  if (booking.source !== 'session') return false;
  if (booking.status === 'confirmed' || booking.status === 'cash_ok') return true;
  if (booking.status === 'pending_payment' && booking.payment_due_at !== null) return true;
  return false;
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
    booking.session_type ? `Type: ${booking.session_type}` : null,
    `Client: ${fullClientName(booking)}`,
    `Email: ${booking.client_email ?? 'n/a'}`,
    `Phone: ${booking.client_phone ?? 'n/a'}`,
    `Booking ID: ${booking.id}`,
    `Booking status: ${booking.status}`,
    `Duration: ${durationMinutes} minutes`,
    `Timezone: ${booking.timezone}`,
  ].filter(Boolean);

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
      booking_status: booking.status,
    },
  };
}

function bookingCalendarEventIdHint(bookingId: string): string {
  return `booking_${bookingId.replace(/-/g, '')}`;
}

async function syncSessionBookingCalendar(
  booking: Booking,
  ctx: BookingContext,
  options: { operation: string; forceUpdate?: boolean },
): Promise<CalendarSyncResult> {
  const { providers, logger, requestId } = ctx;

  // This task only writes Google events for 1:1 sessions.
  if (booking.source !== 'session') {
    await providers.repository.resolveCalendarSyncFailure(booking.id, 'resolved');
    return { booking, calendarSynced: true };
  }

  const needsEvent = shouldSessionBookingHaveCalendarEvent(booking);
  const payload = buildSessionCalendarEventPayload(booking);

  if (!needsEvent) {
    if (!booking.google_event_id) {
      await providers.repository.resolveCalendarSyncFailure(booking.id, 'resolved');
      return { booking, calendarSynced: true };
    }
    try {
      await providers.calendar.deleteEvent(booking.google_event_id);
      const updated = await providers.repository.updateBooking(booking.id, { google_event_id: null });
      await providers.repository.resolveCalendarSyncFailure(booking.id, 'resolved');
      return { booking: updated, calendarSynced: true };
    } catch (err) {
      logger.error('Calendar delete failed', {
        bookingId: booking.id,
        operation: options.operation,
        googleEventId: booking.google_event_id,
        err: String(err),
      });
      await providers.repository.recordCalendarSyncFailure({
        booking_id: booking.id,
        request_id: requestId,
        operation: 'delete',
        error_message: String(err),
        maxAttempts: CALENDAR_SYNC_MAX_ATTEMPTS,
      });
      return { booking, calendarSynced: false };
    }
  }

  if (booking.google_event_id) {
    if (!options.forceUpdate) {
      await providers.repository.resolveCalendarSyncFailure(booking.id, 'resolved');
      return { booking, calendarSynced: true };
    }
    try {
      await providers.calendar.updateEvent(booking.google_event_id, payload);
      await providers.repository.resolveCalendarSyncFailure(booking.id, 'resolved');
      return { booking, calendarSynced: true };
    } catch (err) {
      logger.error('Calendar update failed', {
        bookingId: booking.id,
        operation: options.operation,
        googleEventId: booking.google_event_id,
        err: String(err),
      });
      await providers.repository.recordCalendarSyncFailure({
        booking_id: booking.id,
        request_id: requestId,
        operation: 'update',
        error_message: String(err),
        maxAttempts: CALENDAR_SYNC_MAX_ATTEMPTS,
      });
      return { booking, calendarSynced: false };
    }
  }

  const eventIdHint = bookingCalendarEventIdHint(booking.id);
  try {
    const created = await providers.calendar.createEvent(payload, { eventIdHint });
    const updated = await providers.repository.updateBooking(booking.id, { google_event_id: created.eventId });
    await providers.repository.resolveCalendarSyncFailure(booking.id, 'resolved');
    return { booking: updated, calendarSynced: true };
  } catch (err) {
    logger.error('Calendar create failed', {
      bookingId: booking.id,
      operation: options.operation,
      eventIdHint,
      err: String(err),
    });
    await providers.repository.recordCalendarSyncFailure({
      booking_id: booking.id,
      request_id: requestId,
      operation: 'create',
      error_message: String(err),
      maxAttempts: CALENDAR_SYNC_MAX_ATTEMPTS,
    });
    return { booking, calendarSynced: false };
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
  const token = await buildStableManageToken(booking.id, booking.manage_token_hash);
  return `${siteUrl}/manage.html?token=${encodeURIComponent(token)}`;
}

async function ensureSessionRecoveryState(booking: Booking, ctx: BookingContext): Promise<Booking> {
  if (booking.source !== 'session') return booking;
  if (booking.status === 'pending_payment' && booking.session_type !== 'intro') {
    const synced = await syncSessionBookingCalendar(booking, ctx, {
      operation: 'confirm_email_reentry',
      forceUpdate: true,
    });
    const ensured = await ensureSessionCheckout(synced.booking, ctx);
    return ensured.booking;
  }
  if (booking.status === 'confirmed' || booking.status === 'cash_ok') {
    return (await syncSessionBookingCalendar(booking, ctx, {
      operation: 'confirm_email_reentry',
      forceUpdate: true,
    })).booking;
  }
  return booking;
}

async function ensureSessionCheckout(
  booking: Booking,
  ctx: BookingContext,
): Promise<{ booking: Booking; checkoutUrl: string }> {
  const existing = await ctx.providers.repository.getPaymentByBookingId(booking.id);
  if (existing?.checkout_url) {
    return { booking, checkoutUrl: existing.checkout_url };
  }

  const amountCents = booking.session_type === 'session' ? 18000 : 0;
  const session = await ctx.providers.payments.createCheckoutSession({
    lineItems: [{
      name: `ILLUMINATE 1:1 ${booking.session_type === 'session' ? 'Session' : 'Intro'}`,
      amountCents,
      currency: 'CHF',
      quantity: 1,
    }],
    bookingId: booking.id,
    successUrl: `${ctx.env.SITE_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${ctx.env.SITE_URL}/payment-cancel.html?session_id={CHECKOUT_SESSION_ID}`,
  });

  const updatedBooking = booking.checkout_session_id === session.sessionId
    ? booking
    : await ctx.providers.repository.updateBooking(booking.id, {
        checkout_session_id: session.sessionId,
      });

  if (!existing) {
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
  }

  return {
    booking: updatedBooking,
    checkoutUrl: session.checkoutUrl,
  };
}

async function getCheckoutUrlForBooking(
  bookingId: string,
  repository: Providers['repository'],
): Promise<string | null> {
  const payment = await repository.getPaymentByBookingId(bookingId);
  return payment?.checkout_url ?? null;
}

async function sendEmailBestEffort(
  ctx: BookingContext,
  booking: Booking,
  operation: string,
  send: () => Promise<unknown>,
): Promise<void> {
  try {
    await send();
  } catch (err) {
    ctx.logger.error('Email delivery failed after state transition', {
      bookingId: booking.id,
      operation,
      err: String(err),
    });
    try {
      await ctx.providers.repository.logFailure({
        source: 'email',
        operation,
        booking_id: booking.id,
        request_id: ctx.requestId,
        error_message: String(err),
        retryable: false,
        context: {
          booking_status: booking.status,
          booking_source: booking.source,
          email_delivery_mode: 'best_effort_dev_stage',
        },
      });
    } catch (failureLogError) {
      ctx.logger.error('Failed to persist email delivery failure', {
        bookingId: booking.id,
        operation,
        err: String(failureLogError),
      });
    }
  }
}

async function buildStableManageSignature(bookingId: string, manageTokenHash: string): Promise<string> {
  return hashToken(`m1:${bookingId}:${manageTokenHash}`);
}

async function buildStableManageToken(bookingId: string, manageTokenHash: string): Promise<string> {
  const signature = await buildStableManageSignature(bookingId, manageTokenHash);
  return `m1.${bookingId}.${signature}`;
}

function parseStableManageToken(rawToken: string): { bookingId: string; signature: string } | null {
  const parts = rawToken.split('.');
  if (parts.length !== 3 || parts[0] !== 'm1') return null;
  const bookingId = parts[1] ?? '';
  const signature = parts[2] ?? '';
  if (!bookingId || !signature) return null;
  return { bookingId, signature };
}
