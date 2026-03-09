/**
 * Scheduled job implementations.
 */

import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { AppContext } from '../router.js';
import { ok, unauthorized } from '../lib/errors.js';
import {
  cancelBooking,
  expireBooking,
  retryCalendarSyncForBooking,
  send24hBookingReminder,
  sendPendingBookingFollowup,
} from '../services/booking-service.js';

export interface JobContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
  triggerSource: 'cron' | 'manual';
}

type JobOutcome = 'success' | 'partial_failure' | 'failed';

interface JobSummary {
  items_found: number;
  items_processed: number;
  items_succeeded: number;
  items_failed: number;
}

// ── HTTP handler (manual trigger) ───────────────────────────────────────────

export async function handleJobTrigger(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const auth = request.headers.get('Authorization');
  const expected = `Bearer ${ctx.env.JOB_SECRET ?? ''}`;
  if (!auth || auth !== expected) throw unauthorized('Invalid job secret');

  const name = params['name'];
  await runJob(name ?? '', {
    providers: ctx.providers,
    env: ctx.env,
    logger: ctx.logger,
    requestId: ctx.requestId,
    triggerSource: 'manual',
  });
  return ok({ ok: true, job: name });
}

// ── Cron dispatcher ──────────────────────────────────────────────────────────

export async function runCron(cron: string, ctx: JobContext): Promise<void> {
  switch (cron) {
    case '*/5 * * * *':
      await runCheckoutExpiry(ctx);
      await runCalendarSyncRetries(ctx);
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
    case 'checkout-expiry':
      return runCheckoutExpiry(ctx);
    case 'calendar-sync-retries':
      return runCalendarSyncRetries(ctx);
    case 'unconfirmed-followups':
      return runUnconfirmedFollowups(ctx);
    case 'payment-due-reminders':
      return runPaymentDueReminders(ctx);
    case 'payment-due-cancellations':
      return runPaymentDueCancellations(ctx);
    case '24h-reminders':
      return run24hReminders(ctx);
    default:
      ctx.logger.warn('Unknown job name', { name });
  }
}

function jobOutcome(itemsSucceeded: number, itemsFailed: number): JobOutcome {
  if (itemsFailed === 0) return 'success';
  if (itemsSucceeded > 0) return 'partial_failure';
  return 'failed';
}

function logJobStarted(ctx: JobContext, jobName: string): void {
  ctx.logger.logInfo({
    source: ctx.triggerSource === 'cron' ? 'cron' : 'worker',
    eventType: 'job_run',
    message: `Job ${jobName} started`,
    context: {
      job_name: jobName,
      trigger_source: ctx.triggerSource,
      status: 'running',
    },
  });
}

function logJobCompleted(ctx: JobContext, jobName: string, summary: JobSummary): void {
  const status = jobOutcome(summary.items_succeeded, summary.items_failed);
  const source: 'cron' | 'worker' = ctx.triggerSource === 'cron' ? 'cron' : 'worker';
  const event = {
    source,
    eventType: 'job_run',
    message: `Job ${jobName} completed`,
    context: {
      job_name: jobName,
      trigger_source: ctx.triggerSource,
      status,
      ...summary,
    },
  };

  if (status === 'failed') {
    ctx.logger.logError(event);
    return;
  }
  if (status === 'partial_failure') {
    ctx.logger.logWarn(event);
    return;
  }
  ctx.logger.logInfo(event);
}

// ── Job: expire checkout holds ──────────────────────────────────────────────

async function runCheckoutExpiry(ctx: JobContext): Promise<void> {
  const { providers, logger } = ctx;
  const jobName = 'checkout-expiry';
  logJobStarted(ctx, jobName);

  const bookings = await providers.repository.getExpiredBookingHolds();
  let succeeded = 0;
  let failed = 0;

  for (const b of bookings) {
    try {
      await expireBooking(b, {
        providers,
        env: ctx.env,
        logger,
        requestId: ctx.requestId,
      });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job',
        operation: 'checkout-expiry',
        booking_id: b.id,
        request_id: ctx.requestId,
        error_message: String(err),
        context: { job_name: jobName, trigger_source: ctx.triggerSource },
      });
    }
  }

  logJobCompleted(ctx, jobName, {
    items_found: bookings.length,
    items_processed: bookings.length,
    items_succeeded: succeeded,
    items_failed: failed,
  });
}

// ── Job: retry failed calendar sync operations ──────────────────────────────

async function runCalendarSyncRetries(ctx: JobContext): Promise<void> {
  const { providers, logger } = ctx;
  const jobName = 'calendar-sync-retries';
  logJobStarted(ctx, jobName);

  const failures = await providers.repository.getCalendarSyncFailuresDue(100);
  let succeeded = 0;
  let failed = 0;

  for (const failure of failures) {
    try {
      const booking = await providers.repository.getBookingById(failure.booking_id);
      if (!booking) {
        await providers.repository.resolveCalendarSyncFailure(
          failure.booking_id,
          'ignored',
          'booking_missing',
        );
        succeeded++;
        continue;
      }

      const result = await retryCalendarSyncForBooking(booking, failure.operation, {
        providers,
        env: ctx.env,
        logger,
        requestId: ctx.requestId,
      });

      if (result.calendarSynced) succeeded++;
      else failed++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job',
        operation: 'calendar-sync-retries',
        booking_id: failure.booking_id,
        request_id: ctx.requestId,
        error_message: String(err),
        context: {
          job_name: jobName,
          trigger_source: ctx.triggerSource,
          calendar_operation: failure.operation,
        },
      });
    }
  }

  logJobCompleted(ctx, jobName, {
    items_found: failures.length,
    items_processed: failures.length,
    items_succeeded: succeeded,
    items_failed: failed,
  });
}

// ── Job: unconfirmed followups ──────────────────────────────────────────────

async function runUnconfirmedFollowups(ctx: JobContext): Promise<void> {
  const { providers } = ctx;
  const jobName = 'unconfirmed-followups';
  logJobStarted(ctx, jobName);

  const bookings = await providers.repository.getUnconfirmedBookingFollowupsDue();
  let succeeded = 0;
  let failed = 0;

  for (const b of bookings) {
    try {
      await sendPendingBookingFollowup(b, {
        providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
      });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job',
        operation: 'unconfirmed-followups',
        booking_id: b.id,
        request_id: ctx.requestId,
        error_message: String(err),
        context: { job_name: jobName, trigger_source: ctx.triggerSource },
      });
    }
  }

  logJobCompleted(ctx, jobName, {
    items_found: bookings.length,
    items_processed: bookings.length,
    items_succeeded: succeeded,
    items_failed: failed,
  });
}

// ── Job: payment-due reminders ──────────────────────────────────────────────

async function runPaymentDueReminders(ctx: JobContext): Promise<void> {
  const { providers, env } = ctx;
  const jobName = 'payment-due-reminders';
  logJobStarted(ctx, jobName);

  const bookings = await providers.repository.getPaymentDueRemindersDue();
  let succeeded = 0;
  let failed = 0;

  for (const b of bookings) {
    try {
      const payment = await providers.repository.getPaymentByBookingId(b.id);
      const payUrl = payment?.checkout_url;
      if (!payUrl) {
        throw new Error('No checkout URL available for payment reminder');
      }
      await providers.email.sendBookingPaymentReminder(b, payUrl);
      await providers.repository.updateBooking(b.id, { payment_due_reminder_sent_at: new Date().toISOString() });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job',
        operation: 'payment-due-reminders',
        booking_id: b.id,
        request_id: ctx.requestId,
        error_message: String(err),
        context: { job_name: jobName, trigger_source: ctx.triggerSource },
      });
    }
  }

  logJobCompleted(ctx, jobName, {
    items_found: bookings.length,
    items_processed: bookings.length,
    items_succeeded: succeeded,
    items_failed: failed,
  });
}

// ── Job: payment-due cancellations ──────────────────────────────────────────

async function runPaymentDueCancellations(ctx: JobContext): Promise<void> {
  const { providers, logger } = ctx;
  const jobName = 'payment-due-cancellations';
  logJobStarted(ctx, jobName);

  const bookings = await providers.repository.getPaymentDueCancellationsDue();
  let succeeded = 0;
  let failed = 0;

  for (const b of bookings) {
    try {
      await cancelBooking(b, {
        providers,
        env: ctx.env,
        logger,
        requestId: ctx.requestId,
      });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job',
        operation: 'payment-due-cancellations',
        booking_id: b.id,
        request_id: ctx.requestId,
        error_message: String(err),
        context: { job_name: jobName, trigger_source: ctx.triggerSource },
      });
    }
  }

  logJobCompleted(ctx, jobName, {
    items_found: bookings.length,
    items_processed: bookings.length,
    items_succeeded: succeeded,
    items_failed: failed,
  });
}

// ── Job: 24h reminders ─────────────────────────────────────────────────────

async function run24hReminders(ctx: JobContext): Promise<void> {
  const { providers } = ctx;
  const jobName = '24h-reminders';
  logJobStarted(ctx, jobName);

  const bookings = await providers.repository.get24hBookingRemindersDue();
  let succeeded = 0;
  let failed = 0;

  for (const b of bookings) {
    try {
      await send24hBookingReminder(b, {
        providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
      });
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.logFailure({
        source: 'job',
        operation: '24h-reminders',
        booking_id: b.id,
        request_id: ctx.requestId,
        error_message: String(err),
        context: { job_name: jobName, trigger_source: ctx.triggerSource },
      });
    }
  }

  logJobCompleted(ctx, jobName, {
    items_found: bookings.length,
    items_processed: bookings.length,
    items_succeeded: succeeded,
    items_failed: failed,
  });
}
