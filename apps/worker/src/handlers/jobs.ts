/**
 * Scheduled job implementations. Each job function is designed to be:
 *   - Called directly from the `scheduled` event handler (cron path, no HTTP)
 *   - Also callable via POST /api/jobs/:name for manual triggering (with bearer auth)
 *
 * All jobs are idempotent: safe to run multiple times.
 */

import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { AppContext } from '../router.js';
import { ok, unauthorized, errorResponse } from '../lib/errors.js';

export interface JobContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
}

// ── HTTP handler (manual trigger) ─────────────────────────────────────────────

export async function handleJobTrigger(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const auth = request.headers.get('Authorization');
  const expected = `Bearer ${ctx.env.JOB_SECRET ?? ''}`;
  if (!auth || auth !== expected) throw unauthorized('Invalid job secret');

  const name = params['name'];
  await runJob(name ?? '', { providers: ctx.providers, env: ctx.env, logger: ctx.logger, requestId: ctx.requestId });
  return ok({ ok: true, job: name });
}

// ── Cron dispatcher ───────────────────────────────────────────────────────────

export async function runCron(cron: string, ctx: JobContext): Promise<void> {
  switch (cron) {
    case '*/5 * * * *':
      await runCheckoutExpiry(ctx);
      break;
    case '*/15 * * * *':
      await runUnconfirmedFollowups(ctx);
      await runPaymentDueCancellations(ctx);
      break;
    case '*/30 * * * *':
      await runPaymentDueReminders(ctx);
      break;
    case '0 * * * *':
      await run24hReminders(ctx);
      break;
    default:
      ctx.logger.warn('Unknown cron expression', { cron });
  }
}

async function runJob(name: string, ctx: JobContext): Promise<void> {
  switch (name) {
    case 'checkout-expiry':          return runCheckoutExpiry(ctx);
    case 'unconfirmed-followups':    return runUnconfirmedFollowups(ctx);
    case 'payment-due-reminders':    return runPaymentDueReminders(ctx);
    case 'payment-due-cancellations': return runPaymentDueCancellations(ctx);
    case '24h-reminders':            return run24hReminders(ctx);
    default:
      ctx.logger.warn('Unknown job name', { name });
  }
}

// ── Job: expire checkout holds ────────────────────────────────────────────────

async function runCheckoutExpiry(ctx: JobContext): Promise<void> {
  const { providers, logger } = ctx;
  const run = await providers.repository.createJobRun({ job_name: 'checkout-expiry', request_id: ctx.requestId });

  const [bookings, regs] = await Promise.all([
    providers.repository.getExpiredBookingHolds(),
    providers.repository.getExpiredRegistrationHolds(),
  ]);

  const total = bookings.length + regs.length;
  let succeeded = 0, failed = 0;

  for (const b of bookings) {
    try {
      await providers.repository.updateBooking(b.id, { status: 'expired', checkout_hold_expires_at: null });
      logger.info('expired booking hold', { bookingId: b.id });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job', operation: 'checkout-expiry', booking_id: b.id,
        job_run_id: run.id, error_message: String(err),
      });
    }
  }

  for (const r of regs) {
    try {
      await providers.repository.updateRegistration(r.id, { status: 'expired', checkout_hold_expires_at: null });
      logger.info('expired registration hold', { registrationId: r.id });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job', operation: 'checkout-expiry', event_registration_id: r.id,
        job_run_id: run.id, error_message: String(err),
      });
    }
  }

  await providers.repository.updateJobRun(run.id, {
    status: failed === 0 ? 'success' : succeeded > 0 ? 'partial_failure' : 'failed',
    finished_at: new Date().toISOString(),
    items_found: total, items_processed: total, items_succeeded: succeeded, items_failed: failed,
  });
}

// ── Job: unconfirmed followups ─────────────────────────────────────────────────

async function runUnconfirmedFollowups(ctx: JobContext): Promise<void> {
  const { providers, env, logger } = ctx;
  const run = await providers.repository.createJobRun({ job_name: 'unconfirmed-followups', request_id: ctx.requestId });

  const [bookings, regs] = await Promise.all([
    providers.repository.getUnconfirmedBookingFollowupsDue(),
    providers.repository.getUnconfirmedRegistrationFollowupsDue(),
  ]);

  const total = bookings.length + regs.length;
  let succeeded = 0, failed = 0;

  for (const b of bookings) {
    try {
      const confirmUrl = `${env.SITE_URL}/confirm?type=booking&id=${b.id}&token=RECOVER`;
      await providers.email.sendBookingFollowup(b, confirmUrl);
      await providers.repository.updateBooking(b.id, { followup_sent_at: new Date().toISOString() });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job', operation: 'unconfirmed-followups', booking_id: b.id,
        job_run_id: run.id, error_message: String(err),
      });
    }
  }

  for (const r of regs) {
    try {
      const event = await providers.repository.getEventById(r.event_id);
      if (!event) { failed++; continue; }
      const confirmUrl = `${env.SITE_URL}/confirm?type=registration&id=${r.id}&token=RECOVER`;
      await providers.email.sendRegistrationFollowup(r, event, confirmUrl);
      await providers.repository.updateRegistration(r.id, { followup_sent_at: new Date().toISOString() });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job', operation: 'unconfirmed-followups', event_registration_id: r.id,
        job_run_id: run.id, error_message: String(err),
      });
    }
  }

  await providers.repository.updateJobRun(run.id, {
    status: failed === 0 ? 'success' : succeeded > 0 ? 'partial_failure' : 'failed',
    finished_at: new Date().toISOString(),
    items_found: total, items_processed: total, items_succeeded: succeeded, items_failed: failed,
  });
}

// ── Job: payment-due reminders ────────────────────────────────────────────────

async function runPaymentDueReminders(ctx: JobContext): Promise<void> {
  const { providers, env, logger } = ctx;
  const run = await providers.repository.createJobRun({ job_name: 'payment-due-reminders', request_id: ctx.requestId });

  const bookings = await providers.repository.getPaymentDueRemindersDue();
  let succeeded = 0, failed = 0;

  for (const b of bookings) {
    try {
      const payUrl = `${env.SITE_URL}/book?mode=pay&id=${b.id}`;
      await providers.email.sendBookingPaymentReminder(b, payUrl);
      await providers.repository.updateBooking(b.id, { payment_due_reminder_sent_at: new Date().toISOString() });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job', operation: 'payment-due-reminders', booking_id: b.id,
        job_run_id: run.id, error_message: String(err),
      });
    }
  }

  await providers.repository.updateJobRun(run.id, {
    status: failed === 0 ? 'success' : succeeded > 0 ? 'partial_failure' : 'failed',
    finished_at: new Date().toISOString(),
    items_found: bookings.length, items_processed: bookings.length,
    items_succeeded: succeeded, items_failed: failed,
  });
}

// ── Job: payment-due cancellations ────────────────────────────────────────────

async function runPaymentDueCancellations(ctx: JobContext): Promise<void> {
  const { providers, logger } = ctx;
  const run = await providers.repository.createJobRun({ job_name: 'payment-due-cancellations', request_id: ctx.requestId });

  const bookings = await providers.repository.getPaymentDueCancellationsDue();
  let succeeded = 0, failed = 0;

  for (const b of bookings) {
    try {
      if (b.google_event_id) {
        await providers.calendar.deleteEvent(b.google_event_id).catch((err) =>
          logger.error('Calendar delete failed during auto-cancel', { bookingId: b.id, err: String(err) }),
        );
      }
      await providers.repository.updateBooking(b.id, { status: 'cancelled' });
      await providers.email.sendBookingCancellation(b).catch((err) =>
        logger.error('Cancellation email failed', { bookingId: b.id, err: String(err) }),
      );
      logger.info('auto-cancelled booking for unpaid payment', { bookingId: b.id });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job', operation: 'payment-due-cancellations', booking_id: b.id,
        job_run_id: run.id, error_message: String(err),
      });
    }
  }

  await providers.repository.updateJobRun(run.id, {
    status: failed === 0 ? 'success' : succeeded > 0 ? 'partial_failure' : 'failed',
    finished_at: new Date().toISOString(),
    items_found: bookings.length, items_processed: bookings.length,
    items_succeeded: succeeded, items_failed: failed,
  });
}

// ── Job: 24h reminders ────────────────────────────────────────────────────────

async function run24hReminders(ctx: JobContext): Promise<void> {
  const { providers, env, logger } = ctx;
  const run = await providers.repository.createJobRun({ job_name: '24h-reminders', request_id: ctx.requestId });

  const [bookings, regs] = await Promise.all([
    providers.repository.get24hBookingRemindersDue(),
    providers.repository.get24hRegistrationRemindersDue(),
  ]);

  const total = bookings.length + regs.length;
  let succeeded = 0, failed = 0;

  for (const b of bookings) {
    try {
      const manageUrl = `${env.SITE_URL}/manage?type=booking&id=${b.id}&token=PLACEHOLDER`;
      await providers.email.sendBookingReminder24h(b, manageUrl);
      await providers.repository.updateBooking(b.id, { reminder_24h_sent_at: new Date().toISOString() });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job', operation: '24h-reminders', booking_id: b.id,
        job_run_id: run.id, error_message: String(err),
      });
    }
  }

  for (const r of regs) {
    try {
      const event = await providers.repository.getEventById(r.event_id);
      if (!event) { failed++; continue; }
      const manageUrl = `${env.SITE_URL}/manage?type=registration&id=${r.id}&token=PLACEHOLDER`;
      await providers.email.sendRegistrationReminder24h(r, event, manageUrl);
      await providers.repository.updateRegistration(r.id, { reminder_24h_sent_at: new Date().toISOString() });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job', operation: '24h-reminders', event_registration_id: r.id,
        job_run_id: run.id, error_message: String(err),
      });
    }
  }

  await providers.repository.updateJobRun(run.id, {
    status: failed === 0 ? 'success' : succeeded > 0 ? 'partial_failure' : 'failed',
    finished_at: new Date().toISOString(),
    items_found: total, items_processed: total, items_succeeded: succeeded, items_failed: failed,
  });
}
