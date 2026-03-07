import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { Booking } from '../types.js';
import { generateToken, hashToken, hashesEqual } from './token-service.js';
import { computePaymentDueReminderTime, compute24hReminderTime } from './reminder-service.js';
import { badRequest, conflict, gone, notFound } from '../lib/errors.js';

export interface BookingContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
}

// ── Pay Now ───────────────────────────────────────────────────────────────────

export interface PayNowInput {
  slotStart: string;
  slotEnd: string;
  timezone: string;
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

export async function createPayNowBooking(
  input: PayNowInput,
  ctx: BookingContext,
): Promise<PayNowResult> {
  const { providers, env, logger } = ctx;

  await providers.antibot.verify(input.turnstileToken, input.remoteIp);

  await assertSlotAvailable(input.slotStart, input.slotEnd, providers);

  const manageToken = generateToken();
  const manageTokenHash = await hashToken(manageToken);
  const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const booking = await providers.repository.createBooking({
    client_name:                   input.clientName,
    client_email:                  input.clientEmail,
    client_phone:                  input.clientPhone,
    starts_at:                     input.slotStart,
    ends_at:                       input.slotEnd,
    timezone:                      input.timezone,
    address_line:                  env.SESSION_ADDRESS,
    maps_url:                      env.SESSION_MAPS_URL,
    status:                        'pending_payment',
    confirm_token_hash:            null,
    confirm_expires_at:            null,
    manage_token_hash:             manageTokenHash,
    checkout_hold_expires_at:      holdExpiresAt,
    payment_due_at:                null,
    payment_due_reminder_scheduled_at: null,
    payment_due_reminder_sent_at:  null,
    followup_scheduled_at:         null,
    followup_sent_at:              null,
    reminder_email_opt_in:         input.reminderEmailOptIn,
    reminder_whatsapp_opt_in:      input.reminderWhatsappOptIn,
    reminder_24h_scheduled_at:     null,
    google_event_id:               null,
  });

  const session = await providers.payments.createCheckoutSession({
    lineItems: [{
      name:        'Clarity Session – ILLUMINATE',
      amountCents: 0, // price TBD when Stripe goes live; mock uses 0
      currency:    'CHF',
      quantity:    1,
    }],
    referenceId:   booking.id,
    referenceKind: 'booking',
    successUrl: `${env.SITE_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl:  `${env.SITE_URL}/payment-cancel?session_id={CHECKOUT_SESSION_ID}`,
  });

  await providers.repository.createPayment({
    kind:                       'booking',
    booking_id:                 booking.id,
    event_registration_id:      null,
    stripe_checkout_session_id: session.sessionId,
    stripe_payment_intent_id:   null,
    stripe_invoice_id:          null,
    invoice_url:                null,
    amount_cents:               session.amountCents,
    currency:                   session.currency,
    status:                     'pending',
  });

  logger.info('pay-now booking created', { bookingId: booking.id });

  return {
    bookingId:             booking.id,
    checkoutUrl:           session.checkoutUrl,
    checkoutHoldExpiresAt: holdExpiresAt,
  };
}

// ── Pay Later ─────────────────────────────────────────────────────────────────

export interface PayLaterInput {
  slotStart: string;
  slotEnd: string;
  timezone: string;
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

export async function createPayLaterBooking(
  input: PayLaterInput,
  ctx: BookingContext,
): Promise<PayLaterResult> {
  const { providers, env, logger } = ctx;

  await providers.antibot.verify(input.turnstileToken, input.remoteIp);

  await assertSlotAvailable(input.slotStart, input.slotEnd, providers);

  const confirmToken     = generateToken();
  const confirmTokenHash = await hashToken(confirmToken);
  const manageToken      = generateToken();
  const manageTokenHash  = await hashToken(manageToken);

  const confirmExpiresAt     = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 60 min
  const followupScheduledAt  = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // +2h

  const booking = await providers.repository.createBooking({
    client_name:                   input.clientName,
    client_email:                  input.clientEmail,
    client_phone:                  input.clientPhone,
    starts_at:                     input.slotStart,
    ends_at:                       input.slotEnd,
    timezone:                      input.timezone,
    address_line:                  env.SESSION_ADDRESS,
    maps_url:                      env.SESSION_MAPS_URL,
    status:                        'pending_email',
    confirm_token_hash:            confirmTokenHash,
    confirm_expires_at:            confirmExpiresAt,
    manage_token_hash:             manageTokenHash,
    checkout_hold_expires_at:      null,
    payment_due_at:                null,
    payment_due_reminder_scheduled_at: null,
    payment_due_reminder_sent_at:  null,
    followup_scheduled_at:         followupScheduledAt,
    followup_sent_at:              null,
    reminder_email_opt_in:         input.reminderEmailOptIn,
    reminder_whatsapp_opt_in:      input.reminderWhatsappOptIn,
    reminder_24h_scheduled_at:     null,
    google_event_id:               null,
  });

  const confirmUrl = buildConfirmUrl(env.SITE_URL, 'booking', confirmToken, booking.id);

  try {
    await providers.email.sendBookingConfirmRequest(booking, confirmUrl);
  } catch (err) {
    logger.error('Failed to send confirm email', { bookingId: booking.id, err: String(err) });
    await providers.repository.logFailure({
      source:     'email',
      operation:  'sendBookingConfirmRequest',
      booking_id: booking.id,
      request_id: ctx.requestId,
      error_message: String(err),
    });
    // Don't throw — booking was created; user can be retried
  }

  logger.info('pay-later booking created', { bookingId: booking.id });
  return { bookingId: booking.id, status: 'pending_email' };
}

// ── Email confirmation ────────────────────────────────────────────────────────

export async function confirmBookingEmail(
  rawToken: string,
  bookingId: string,
  ctx: BookingContext,
): Promise<Booking> {
  const { providers, env, logger } = ctx;

  const booking = await providers.repository.getBookingById(bookingId);
  if (!booking) throw notFound('Booking not found');
  if (booking.status !== 'pending_email') throw gone('This confirmation link is no longer valid');

  const tokenHash = await hashToken(rawToken);
  if (!booking.confirm_token_hash || !hashesEqual(tokenHash, booking.confirm_token_hash)) {
    throw notFound('Booking not found'); // don't reveal existence
  }
  if (booking.confirm_expires_at && new Date(booking.confirm_expires_at) < new Date()) {
    throw gone('This confirmation link has expired');
  }

  // Compute pay-later lifecycle timestamps
  const startsAt     = new Date(booking.starts_at);
  const paymentDueAt = new Date(startsAt.getTime() - 24 * 60 * 60 * 1000);
  const reminderTime = computePaymentDueReminderTime(paymentDueAt, booking.timezone);
  const reminder24h  = compute24hReminderTime(startsAt);

  // Create calendar event
  let googleEventId: string | null = null;
  try {
    const result = await providers.calendar.createEvent({
      title:          `Clarity Session — ${booking.client_name}`,
      description:    `1:1 session with ${booking.client_name} (${booking.client_email})`,
      startIso:       booking.starts_at,
      endIso:         booking.ends_at,
      location:       booking.address_line,
      attendeeEmail:  booking.client_email,
      attendeeName:   booking.client_name,
    });
    googleEventId = result.eventId;
  } catch (err) {
    logger.error('Calendar event creation failed', { bookingId: booking.id, err: String(err) });
    await providers.repository.logFailure({
      source: 'calendar', operation: 'createEvent',
      booking_id: booking.id, request_id: ctx.requestId,
      error_message: String(err),
    });
  }

  const manageToken     = generateToken();
  const manageTokenHash = await hashToken(manageToken);

  const updated = await providers.repository.updateBooking(booking.id, {
    status:                            'pending_payment',
    confirm_token_hash:                null,
    confirm_expires_at:                null,
    manage_token_hash:                 manageTokenHash,
    payment_due_at:                    paymentDueAt.toISOString(),
    payment_due_reminder_scheduled_at: reminderTime.toISOString(),
    reminder_24h_scheduled_at:         reminder24h?.toISOString() ?? null,
    google_event_id:                   googleEventId,
  });

  // Send "pay now" email
  const payUrl    = `${env.SITE_URL}/book?mode=pay&id=${booking.id}`;
  const manageUrl = buildManageUrl(env.SITE_URL, 'booking', manageToken, booking.id);

  try {
    await providers.email.sendBookingPaymentDue(updated, payUrl, manageUrl);
  } catch (err) {
    logger.error('Failed to send payment due email', { bookingId: booking.id, err: String(err) });
    await providers.repository.logFailure({
      source: 'email', operation: 'sendBookingPaymentDue',
      booking_id: booking.id, request_id: ctx.requestId,
      error_message: String(err),
    });
  }

  logger.info('booking email confirmed', { bookingId: booking.id });
  return updated;
}

// ── Payment confirmation (called from webhook handler) ────────────────────────

export async function confirmBookingPayment(
  payment: { id: string; booking_id: string | null; stripe_checkout_session_id: string },
  stripeData: { paymentIntentId: string | null; invoiceId: string | null; invoiceUrl: string | null },
  ctx: BookingContext,
): Promise<void> {
  const { providers, env, logger } = ctx;

  if (!payment.booking_id) throw new Error('Payment has no booking_id');

  await providers.repository.updatePayment(payment.id, {
    status:                 'succeeded',
    stripe_payment_intent_id: stripeData.paymentIntentId,
    stripe_invoice_id:      stripeData.invoiceId,
    invoice_url:            stripeData.invoiceUrl,
  });

  const booking = await providers.repository.getBookingById(payment.booking_id);
  if (!booking) {
    logger.error('Booking not found for payment', { paymentId: payment.id });
    return;
  }

  // Create calendar event if not already created (pay-now path)
  let googleEventId = booking.google_event_id;
  if (!googleEventId) {
    try {
      const result = await providers.calendar.createEvent({
        title:         `Clarity Session — ${booking.client_name}`,
        description:   `1:1 session with ${booking.client_name} (${booking.client_email})`,
        startIso:      booking.starts_at,
        endIso:        booking.ends_at,
        location:      booking.address_line,
        attendeeEmail: booking.client_email,
        attendeeName:  booking.client_name,
      });
      googleEventId = result.eventId;
    } catch (err) {
      logger.error('Calendar event creation failed post-payment', { bookingId: booking.id, err: String(err) });
      await providers.repository.logFailure({
        source: 'calendar', operation: 'createEvent',
        booking_id: booking.id, request_id: ctx.requestId,
        error_message: String(err),
      });
    }
  }

  const startsAt    = new Date(booking.starts_at);
  const reminder24h = compute24hReminderTime(startsAt);

  const manageToken     = generateToken();
  const manageTokenHash = await hashToken(manageToken);

  const updated = await providers.repository.updateBooking(booking.id, {
    status:                    'confirmed',
    checkout_hold_expires_at:  null,
    manage_token_hash:         manageTokenHash,
    google_event_id:           googleEventId,
    reminder_24h_scheduled_at: booking.reminder_24h_scheduled_at ?? reminder24h?.toISOString() ?? null,
  });

  const manageUrl = buildManageUrl(env.SITE_URL, 'booking', manageToken, booking.id);

  try {
    await providers.email.sendBookingConfirmation(updated, manageUrl, stripeData.invoiceUrl);
  } catch (err) {
    logger.error('Failed to send booking confirmation email', { bookingId: booking.id, err: String(err) });
    await providers.repository.logFailure({
      source: 'email', operation: 'sendBookingConfirmation',
      booking_id: booking.id, request_id: ctx.requestId,
      error_message: String(err),
    });
  }

  logger.info('booking payment confirmed', { bookingId: booking.id });
}

// ── Manage-token resolution ───────────────────────────────────────────────────

export async function resolveBookingByManageToken(
  rawToken: string,
  bookingId: string,
  repository: Providers['repository'],
): Promise<Booking> {
  const booking = await repository.getBookingById(bookingId);
  if (!booking) throw notFound('Booking not found');

  const tokenHash = await hashToken(rawToken);
  if (!hashesEqual(tokenHash, booking.manage_token_hash)) {
    throw notFound('Booking not found');
  }

  return booking;
}

export async function cancelBooking(
  booking: Booking,
  ctx: BookingContext,
): Promise<void> {
  const { providers, logger } = ctx;

  const cancellable: Booking['status'][] = ['pending_email', 'pending_payment', 'confirmed', 'cash_ok'];
  if (!cancellable.includes(booking.status)) {
    throw badRequest('Booking cannot be cancelled in its current state');
  }

  if (booking.google_event_id) {
    try {
      await providers.calendar.deleteEvent(booking.google_event_id);
    } catch (err) {
      logger.error('Calendar delete failed on cancellation', { bookingId: booking.id, err: String(err) });
    }
  }

  await providers.repository.updateBooking(booking.id, { status: 'cancelled' });

  try {
    await providers.email.sendBookingCancellation(booking);
  } catch (err) {
    logger.error('Failed to send cancellation email', { bookingId: booking.id, err: String(err) });
  }

  logger.info('booking cancelled', { bookingId: booking.id });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function assertSlotAvailable(start: string, end: string, providers: Providers): Promise<void> {
  const from = start.slice(0, 10);
  const to   = end.slice(0, 10);

  const [busyTimes, heldSlots] = await Promise.all([
    providers.calendar.getBusyTimes(from, to),
    providers.repository.getHeldSlots(from, to),
  ]);

  const allBusy = [...busyTimes, ...heldSlots];
  const startMs = new Date(start).getTime();
  const endMs   = new Date(end).getTime();

  for (const busy of allBusy) {
    const bStart = new Date(busy.start).getTime();
    const bEnd   = new Date(busy.end).getTime();
    if (startMs < bEnd && endMs > bStart) {
      throw conflict('This slot is no longer available');
    }
  }
}

function buildConfirmUrl(siteUrl: string, type: string, rawToken: string, id: string): string {
  return `${siteUrl}/confirm?type=${type}&token=${encodeURIComponent(rawToken)}&id=${encodeURIComponent(id)}`;
}

function buildManageUrl(siteUrl: string, type: string, rawToken: string, id: string): string {
  return `${siteUrl}/manage?type=${type}&token=${encodeURIComponent(rawToken)}&id=${encodeURIComponent(id)}`;
}


