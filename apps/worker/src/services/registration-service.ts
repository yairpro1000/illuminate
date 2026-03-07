import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { Event, EventRegistration } from '../types.js';
import { generateToken, hashToken, hashesEqual } from './token-service.js';
import { compute24hReminderTime } from './reminder-service.js';
import { badRequest, gone, notFound } from '../lib/errors.js';

export interface RegistrationContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
}

// ── Free event registration ───────────────────────────────────────────────────

export interface FreeRegistrationInput {
  event: Event;
  primaryName: string;
  primaryEmail: string;
  primaryPhone: string;
  additionalAttendees: string[];
  reminderEmailOptIn: boolean;
  reminderWhatsappOptIn: boolean;
  turnstileToken: string;
  remoteIp: string | null;
}

export interface FreeRegistrationResult {
  registrationId: string;
  status: 'pending_email';
}

export async function createFreeRegistration(
  input: FreeRegistrationInput,
  ctx: RegistrationContext,
): Promise<FreeRegistrationResult> {
  const { providers, env, logger } = ctx;

  await providers.antibot.verify(input.turnstileToken, input.remoteIp);

  const confirmToken     = generateToken();
  const confirmTokenHash = await hashToken(confirmToken);
  const manageToken      = generateToken();
  const manageTokenHash  = await hashToken(manageToken);

  const confirmExpiresAt    = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min
  const followupScheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const reg = await providers.repository.createRegistration(
    {
      event_id:                input.event.id,
      primary_name:            input.primaryName,
      primary_email:           input.primaryEmail,
      primary_phone:           input.primaryPhone || null,
      attendee_count:          1 + input.additionalAttendees.length,
      status:                  'pending_email',
      confirm_token_hash:      confirmTokenHash,
      confirm_expires_at:      confirmExpiresAt,
      manage_token_hash:       manageTokenHash,
      checkout_hold_expires_at: null,
      followup_scheduled_at:   followupScheduledAt,
      followup_sent_at:        null,
      reminder_email_opt_in:   input.reminderEmailOptIn,
      reminder_whatsapp_opt_in: input.reminderWhatsappOptIn,
      reminder_24h_scheduled_at: null,
      reminder_24h_sent_at:    null,
    },
    input.additionalAttendees,
  );

  const confirmUrl = `${env.SITE_URL}/confirm?type=registration&token=${encodeURIComponent(confirmToken)}&id=${encodeURIComponent(reg.id)}`;

  try {
    await providers.email.sendRegistrationConfirmRequest(reg, input.event, confirmUrl);
  } catch (err) {
    logger.error('Failed to send registration confirm email', { registrationId: reg.id, err: String(err) });
    await providers.repository.logFailure({
      source: 'email', operation: 'sendRegistrationConfirmRequest',
      event_registration_id: reg.id, request_id: ctx.requestId,
      error_message: String(err),
    });
  }

  logger.info('free registration created', { registrationId: reg.id, eventId: input.event.id });
  return { registrationId: reg.id, status: 'pending_email' };
}

// ── Paid event registration ───────────────────────────────────────────────────

export interface PaidRegistrationInput {
  event: Event;
  primaryName: string;
  primaryEmail: string;
  primaryPhone: string | null;
  additionalAttendees: string[];
  reminderEmailOptIn: boolean;
  reminderWhatsappOptIn: boolean;
  turnstileToken: string;
  remoteIp: string | null;
}

export interface PaidRegistrationResult {
  registrationId: string;
  status: 'pending_payment';
  checkoutUrl: string;
  checkoutHoldExpiresAt: string;
}

export async function createPaidRegistration(
  input: PaidRegistrationInput,
  ctx: RegistrationContext,
): Promise<PaidRegistrationResult> {
  const { providers, env, logger } = ctx;

  await providers.antibot.verify(input.turnstileToken, input.remoteIp);

  if (!input.event.price_per_person_cents) throw badRequest('Event has no price configured');

  const manageToken      = generateToken();
  const manageTokenHash  = await hashToken(manageToken);
  const holdExpiresAt    = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const followupAt       = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const totalAttendees   = 1 + input.additionalAttendees.length;

  const reg = await providers.repository.createRegistration(
    {
      event_id:                input.event.id,
      primary_name:            input.primaryName,
      primary_email:           input.primaryEmail,
      primary_phone:           input.primaryPhone,
      attendee_count:          totalAttendees,
      status:                  'pending_payment',
      confirm_token_hash:      null,
      confirm_expires_at:      null,
      manage_token_hash:       manageTokenHash,
      checkout_hold_expires_at: holdExpiresAt,
      followup_scheduled_at:   followupAt,
      followup_sent_at:        null,
      reminder_email_opt_in:   input.reminderEmailOptIn,
      reminder_whatsapp_opt_in: input.reminderWhatsappOptIn,
      reminder_24h_scheduled_at: null,
      reminder_24h_sent_at:    null,
    },
    input.additionalAttendees,
  );

  const session = await providers.payments.createCheckoutSession({
    lineItems: [{
      name:        `${input.event.title} — ILLUMINATE`,
      description: `${totalAttendees} attendee${totalAttendees > 1 ? 's' : ''}`,
      amountCents: input.event.price_per_person_cents * totalAttendees,
      currency:    input.event.currency,
      quantity:    1,
    }],
    referenceId:   reg.id,
    referenceKind: 'event_registration',
    successUrl: `${env.SITE_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl:  `${env.SITE_URL}/payment-cancel?session_id={CHECKOUT_SESSION_ID}`,
  });

  await providers.repository.createPayment({
    kind:                       'event_registration',
    booking_id:                 null,
    event_registration_id:      reg.id,
    stripe_checkout_session_id: session.sessionId,
    stripe_payment_intent_id:   null,
    stripe_invoice_id:          null,
    invoice_url:                null,
    amount_cents:               session.amountCents,
    currency:                   session.currency,
    status:                     'pending',
  });

  logger.info('paid registration created', { registrationId: reg.id, eventId: input.event.id });

  return {
    registrationId:        reg.id,
    status:                'pending_payment',
    checkoutUrl:           session.checkoutUrl,
    checkoutHoldExpiresAt: holdExpiresAt,
  };
}

// ── Email confirmation (free event) ──────────────────────────────────────────

export async function confirmRegistrationEmail(
  rawToken: string,
  registrationId: string,
  ctx: RegistrationContext,
): Promise<EventRegistration> {
  const { providers, env, logger } = ctx;

  const reg = await providers.repository.getRegistrationById(registrationId);
  if (!reg) throw notFound('Registration not found');
  if (reg.status !== 'pending_email') throw gone('This confirmation link is no longer valid');

  const tokenHash = await hashToken(rawToken);
  if (!reg.confirm_token_hash || !hashesEqual(tokenHash, reg.confirm_token_hash)) {
    throw notFound('Registration not found');
  }
  if (reg.confirm_expires_at && new Date(reg.confirm_expires_at) < new Date()) {
    throw gone('This confirmation link has expired');
  }

  const event = await providers.repository.getEventById(reg.event_id);
  if (!event) throw notFound('Event not found');

  const reminder24h  = compute24hReminderTime(new Date(event.starts_at));
  const manageToken  = generateToken();
  const manageTokenHash = await hashToken(manageToken);

  const updated = await providers.repository.updateRegistration(reg.id, {
    status:                  'confirmed',
    confirm_token_hash:      null,
    confirm_expires_at:      null,
    manage_token_hash:       manageTokenHash,
    reminder_24h_scheduled_at: reg.reminder_email_opt_in ? (reminder24h?.toISOString() ?? null) : null,
  });

  const manageUrl = `${env.SITE_URL}/manage?type=registration&id=${reg.id}&token=${encodeURIComponent(manageToken)}`;

  try {
    await providers.email.sendRegistrationConfirmation(updated, event, manageUrl, null);
  } catch (err) {
    logger.error('Failed to send registration confirmation email', { registrationId: reg.id, err: String(err) });
    await providers.repository.logFailure({
      source: 'email', operation: 'sendRegistrationConfirmation',
      event_registration_id: reg.id, request_id: ctx.requestId,
      error_message: String(err),
    });
  }

  logger.info('registration email confirmed', { registrationId: reg.id });
  return updated;
}

// ── Payment confirmation (called from webhook handler) ────────────────────────

export async function confirmRegistrationPayment(
  payment: { id: string; event_registration_id: string | null; stripe_checkout_session_id: string },
  stripeData: { paymentIntentId: string | null; invoiceId: string | null; invoiceUrl: string | null },
  ctx: RegistrationContext,
): Promise<void> {
  const { providers, env, logger } = ctx;

  if (!payment.event_registration_id) throw new Error('Payment has no event_registration_id');

  await providers.repository.updatePayment(payment.id, {
    status:                  'succeeded',
    stripe_payment_intent_id: stripeData.paymentIntentId,
    stripe_invoice_id:       stripeData.invoiceId,
    invoice_url:             stripeData.invoiceUrl,
  });

  const reg = await providers.repository.getRegistrationById(payment.event_registration_id);
  if (!reg) { logger.error('Registration not found for payment', { paymentId: payment.id }); return; }

  const event = await providers.repository.getEventById(reg.event_id);
  if (!event) { logger.error('Event not found for registration payment', { regId: reg.id }); return; }

  const reminder24h  = compute24hReminderTime(new Date(event.starts_at));
  const manageToken  = generateToken();
  const manageTokenHash = await hashToken(manageToken);

  const updated = await providers.repository.updateRegistration(reg.id, {
    status:                    'confirmed',
    checkout_hold_expires_at:  null,
    manage_token_hash:         manageTokenHash,
    reminder_24h_scheduled_at: reg.reminder_email_opt_in ? (reminder24h?.toISOString() ?? null) : null,
  });

  const manageUrl = `${env.SITE_URL}/manage?type=registration&id=${reg.id}&token=${encodeURIComponent(manageToken)}`;

  try {
    await providers.email.sendRegistrationConfirmation(updated, event, manageUrl, stripeData.invoiceUrl);
  } catch (err) {
    logger.error('Failed to send registration confirmation email', { registrationId: reg.id, err: String(err) });
    await providers.repository.logFailure({
      source: 'email', operation: 'sendRegistrationConfirmation',
      event_registration_id: reg.id, request_id: ctx.requestId,
      error_message: String(err),
    });
  }

  logger.info('registration payment confirmed', { registrationId: reg.id });
}

// ── Manage-token resolution ───────────────────────────────────────────────────

export async function resolveRegistrationByManageToken(
  rawToken: string,
  registrationId: string,
  repository: Providers['repository'],
): Promise<EventRegistration> {
  const reg = await repository.getRegistrationById(registrationId);
  if (!reg) throw notFound('Registration not found');

  const tokenHash = await hashToken(rawToken);
  if (!hashesEqual(tokenHash, reg.manage_token_hash)) {
    throw notFound('Registration not found');
  }

  return reg;
}

export async function cancelRegistration(
  reg: EventRegistration,
  ctx: RegistrationContext,
): Promise<void> {
  const { providers, logger } = ctx;

  const cancellable: EventRegistration['status'][] = ['pending_email', 'pending_payment', 'confirmed'];
  if (!cancellable.includes(reg.status)) {
    throw badRequest('Registration cannot be cancelled in its current state');
  }

  await providers.repository.updateRegistration(reg.id, { status: 'cancelled' });
  logger.info('registration cancelled', { registrationId: reg.id });
}
