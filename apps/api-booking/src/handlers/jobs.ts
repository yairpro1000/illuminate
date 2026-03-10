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
import { buildManageUrl } from '../services/booking-service.js';

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

const PRIMARY_CRON_EXPRESSION = '* * * * *';
const KNOWN_CRON_EXPRESSIONS = new Set([
  PRIMARY_CRON_EXPRESSION,
  '*/5 * * * *',
  '*/15 * * * *',
  '*/30 * * * *',
  '0 * * * *',
]);

const CRON_SWEEP_STEPS: ReadonlyArray<{
  jobName: string;
  run: (ctx: JobContext) => Promise<void>;
}> = [
  { jobName: 'checkout-expiry', run: runCheckoutExpiry },
  { jobName: 'unconfirmed-followups', run: runUnconfirmedFollowups },
  { jobName: 'payment-due-cancellations', run: runPaymentDueCancellations },
  { jobName: 'payment-due-reminders', run: runPaymentDueReminders },
  { jobName: '24h-reminders', run: run24hReminders },
  { jobName: 'side-effects-dispatcher', run: runSideEffectsOutbox },
  { jobName: 'calendar-sync-retries', run: runCalendarSyncRetries },
];

const MANUAL_JOB_NAMES = new Set([
  'checkout-expiry',
  'calendar-sync-retries',
  'unconfirmed-followups',
  'payment-due-reminders',
  'payment-due-cancellations',
  '24h-reminders',
  'cron-sweep',
]);

function jobLogSource(ctx: JobContext): 'cron' | 'worker' {
  return ctx.triggerSource === 'cron' ? 'cron' : 'worker';
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
  const source = jobLogSource(ctx);
  const isKnownExpression = KNOWN_CRON_EXPRESSIONS.has(cron);

  ctx.logger.logInfo({
    source,
    eventType: 'cron_dispatch_decision',
    message: 'Cron dispatch decision evaluated',
    context: {
      received_cron_expression: cron,
      known_cron_expressions: Array.from(KNOWN_CRON_EXPRESSIONS),
      trigger_source: ctx.triggerSource,
      branch_taken: isKnownExpression
        ? 'run_unified_sweep_known_expression'
        : 'run_unified_sweep_unknown_expression',
    },
  });

  if (!isKnownExpression) {
    ctx.logger.logWarn({
      source,
      eventType: 'cron_dispatch_fallback',
      message: 'Unknown cron expression executed by unified dispatcher',
      context: {
        received_cron_expression: cron,
        known_cron_expressions: Array.from(KNOWN_CRON_EXPRESSIONS),
        trigger_source: ctx.triggerSource,
        fallback_reason: 'unknown_cron_expression',
        temporary_debug: true,
      },
    });
  }

  if (cron !== PRIMARY_CRON_EXPRESSION) {
    ctx.logger.logInfo({
      source,
      eventType: 'cron_dispatch_compatibility_mode',
      message: 'Legacy cron expression mapped to unified sweep',
      context: {
        received_cron_expression: cron,
        mapped_cron_expression: PRIMARY_CRON_EXPRESSION,
        trigger_source: ctx.triggerSource,
        temporary_debug: true,
      },
    });
  }

  await runUnifiedCronSweep(cron, ctx);
}

async function runJob(name: string, ctx: JobContext): Promise<void> {
  const requestedName = name.trim();
  const branchTaken = MANUAL_JOB_NAMES.has(requestedName) ? `run_${requestedName}` : 'unknown_job_name';
  ctx.logger.logInfo({
    source: jobLogSource(ctx),
    eventType: 'job_dispatch_decision',
    message: 'Manual job dispatch decision evaluated',
    context: {
      requested_job_name: requestedName || null,
      trigger_source: ctx.triggerSource,
      branch_taken: branchTaken,
    },
  });

  switch (requestedName) {
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
    case 'cron-sweep':
      return runUnifiedCronSweep('manual:cron-sweep', ctx);
    default:
      ctx.logger.logWarn({
        source: jobLogSource(ctx),
        eventType: 'job_dispatch_rejected',
        message: 'Unknown job name',
        context: {
          requested_job_name: requestedName || null,
          trigger_source: ctx.triggerSource,
          deny_reason: 'unknown_job_name',
        },
      });
  }
}

async function runUnifiedCronSweep(cron: string, ctx: JobContext): Promise<void> {
  const source = jobLogSource(ctx);
  const startedAt = Date.now();
  const failedSteps: string[] = [];

  ctx.logger.logInfo({
    source,
    eventType: 'cron_sweep_started',
    message: 'Unified cron sweep started',
    context: {
      cron_expression: cron,
      trigger_source: ctx.triggerSource,
      status: 'running',
      total_steps: CRON_SWEEP_STEPS.length,
    },
  });

  for (const step of CRON_SWEEP_STEPS) {
    ctx.logger.logInfo({
      source,
      eventType: 'cron_sweep_step',
      message: `Cron sweep step ${step.jobName} started`,
      context: {
        cron_expression: cron,
        trigger_source: ctx.triggerSource,
        job_name: step.jobName,
        status: 'running',
      },
    });

    try {
      await step.run(ctx);
      ctx.logger.logInfo({
        source,
        eventType: 'cron_sweep_step',
        message: `Cron sweep step ${step.jobName} completed`,
        context: {
          cron_expression: cron,
          trigger_source: ctx.triggerSource,
          job_name: step.jobName,
          status: 'success',
        },
      });
    } catch (error) {
      failedSteps.push(step.jobName);
      ctx.logger.logError({
        source,
        eventType: 'cron_sweep_step',
        message: `Cron sweep step ${step.jobName} failed`,
        context: {
          cron_expression: cron,
          trigger_source: ctx.triggerSource,
          job_name: step.jobName,
          status: 'failed',
          failure_reason: String(error),
        },
      });
    }
  }

  const duration_ms = Date.now() - startedAt;
  const summaryContext = {
    cron_expression: cron,
    trigger_source: ctx.triggerSource,
    total_steps: CRON_SWEEP_STEPS.length,
    succeeded_steps: CRON_SWEEP_STEPS.length - failedSteps.length,
    failed_steps: failedSteps.length,
    failed_job_names: failedSteps,
    duration_ms,
  };

  if (failedSteps.length > 0) {
    ctx.logger.logWarn({
      source,
      eventType: 'cron_sweep_completed',
      message: 'Unified cron sweep completed with failures',
      context: {
        ...summaryContext,
        status: 'partial_failure',
      },
    });
    throw new Error(`Cron sweep failed in ${failedSteps.length} step(s): ${failedSteps.join(', ')}`);
  }

  ctx.logger.logInfo({
    source,
    eventType: 'cron_sweep_completed',
    message: 'Unified cron sweep completed',
    context: {
      ...summaryContext,
      status: 'success',
    },
  });
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

export async function runCheckoutExpiry(ctx: JobContext): Promise<void> {
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

export async function runPaymentDueReminders(ctx: JobContext): Promise<void> {
  const { providers, env } = ctx;
  const jobName = 'payment-due-reminders';
  logJobStarted(ctx, jobName);

  const bookings = await providers.repository.getPaymentDueRemindersDue();
  let succeeded = 0;
  let failed = 0;

  for (const b of bookings) {
    try {
      await providers.repository.enqueueSideEffect({
        booking_id: b.id,
        effect_type: 'email.payment_reminder.session',
        payload: {},
      });
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

export async function runPaymentDueCancellations(ctx: JobContext): Promise<void> {
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

export async function run24hReminders(ctx: JobContext): Promise<void> {
  const { providers } = ctx;
  const jobName = '24h-reminders';
  logJobStarted(ctx, jobName);

  const bookings = await providers.repository.get24hBookingRemindersDue();
  let succeeded = 0;
  let failed = 0;

  for (const b of bookings) {
    try {
      await providers.repository.enqueueSideEffect({
        booking_id: b.id,
        effect_type: b.source === 'session' ? 'email.reminder24h.session' : 'email.reminder24h.event',
        payload: {},
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

// ── Job: side-effects outbox dispatcher ─────────────────────────────────────

export async function runSideEffectsOutbox(ctx: JobContext): Promise<void> {
  const { providers, env } = ctx;
  const jobName = 'side-effects-dispatcher';
  logJobStarted(ctx, jobName);

  const effects = await providers.repository.getPendingSideEffects(50);
  let succeeded = 0;
  let failed = 0;

  for (const eff of effects) {
    try {
      await providers.repository.markSideEffect(eff.id, 'processing', null);
      const booking = await providers.repository.getBookingById(eff.booking_id);
      if (!booking) {
        await providers.repository.markSideEffect(eff.id, 'failed', 'booking not found');
        failed++;
        continue;
      }

      const payload = eff.payload || {};
      switch (eff.effect_type) {
        case 'email.confirm_request.session': {
          const confirmUrl = String(payload['confirm_url'] || '');
          await providers.email.sendBookingConfirmRequest(booking, confirmUrl);
          break;
        }
        case 'email.confirm_request.event': {
          if (!booking.event_id) throw new Error('event_id missing');
          const event = await providers.repository.getEventById(booking.event_id);
          if (!event) throw new Error('event not found');
          const confirmUrl = String(payload['confirm_url'] || '');
          await providers.email.sendEventConfirmRequest(booking, event, confirmUrl);
          break;
        }
        case 'email.payment_due.session': {
          const payment = await providers.repository.getPaymentByBookingId(booking.id);
          const payUrl = payment?.checkout_url;
          if (!payUrl) throw new Error('no checkout url');
          const manageUrl = await buildManageUrl(env.SITE_URL, booking);
          await providers.email.sendBookingPaymentDue(booking, payUrl, manageUrl);
          break;
        }
        case 'email.payment_reminder.session': {
          const payment = await providers.repository.getPaymentByBookingId(booking.id);
          const payUrl = payment?.checkout_url;
          if (!payUrl) throw new Error('no checkout url');
          await providers.email.sendBookingPaymentReminder(booking, payUrl);
          await providers.repository.updateBooking(booking.id, { payment_due_reminder_sent_at: new Date().toISOString(), reminder_36h_sent_at: new Date().toISOString() });
          break;
        }
        case 'email.confirmed.session': {
          const manageUrl = await buildManageUrl(env.SITE_URL, booking);
          const invoiceUrl = typeof payload['invoice_url'] === 'string' ? payload['invoice_url'] : null;
          await providers.email.sendBookingConfirmation(booking, manageUrl, invoiceUrl);
          break;
        }
        case 'email.confirmed.event': {
          if (!booking.event_id) throw new Error('event_id missing');
          const event = await providers.repository.getEventById(booking.event_id);
          if (!event) throw new Error('event not found');
          const manageUrl = await buildManageUrl(env.SITE_URL, booking);
          const invoiceUrl = typeof payload['invoice_url'] === 'string' ? payload['invoice_url'] : null;
          await providers.email.sendEventConfirmation(booking, event, manageUrl, invoiceUrl);
          break;
        }
        case 'email.cancellation.session': {
          await providers.email.sendBookingCancellation(booking);
          break;
        }
        case 'email.reminder24h.session': {
          const manageUrl = await buildManageUrl(env.SITE_URL, booking);
          await providers.email.sendBookingReminder24h(booking, manageUrl);
          await providers.repository.updateBooking(booking.id, { reminder_24h_sent_at: new Date().toISOString() });
          break;
        }
        case 'email.reminder24h.event': {
          if (!booking.event_id) throw new Error('event_id missing');
          const event = await providers.repository.getEventById(booking.event_id);
          if (!event) throw new Error('event not found');
          const manageUrl = await buildManageUrl(env.SITE_URL, booking);
          await providers.email.sendEventReminder24h(booking, event, manageUrl);
          await providers.repository.updateBooking(booking.id, { reminder_24h_sent_at: new Date().toISOString() });
          break;
        }
        default:
          throw new Error(`unknown effect_type: ${eff.effect_type}`);
      }

      await providers.repository.markSideEffect(eff.id, 'done', null);
      succeeded++;
    } catch (err) {
      failed++;
      await providers.repository.markSideEffect(eff.id, 'failed', String(err));
      await providers.repository.logFailure({
        source: 'job',
        operation: 'side-effects-dispatcher',
        booking_id: eff.booking_id,
        request_id: ctx.requestId,
        error_message: String(err),
        context: { job_name: jobName, trigger_source: ctx.triggerSource, effect_type: eff.effect_type },
      });
    }
  }

  logJobCompleted(ctx, jobName, {
    items_found: effects.length,
    items_processed: effects.length,
    items_succeeded: succeeded,
    items_failed: failed,
  });
}
