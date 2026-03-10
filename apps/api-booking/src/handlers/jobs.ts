/**
 * Scheduled job implementations for the booking event/side-effect model.
 */

import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { AppContext } from '../router.js';
import { ok, unauthorized } from '../lib/errors.js';
import {
  buildConfirmUrl,
  buildManageUrl,
  expireBooking,
  retryCalendarSyncForBooking,
  send24hBookingReminder,
  sendPendingBookingFollowup,
} from '../services/booking-service.js';
import { appendBookingEventWithEffects } from '../services/booking-transition.js';
import { sideEffectStatusAfterAttempt } from '../providers/repository/interface.js';
import type { BookingCurrentStatus, BookingEffectIntent, BookingSideEffect } from '../types.js';

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
  { jobName: 'payment-due-reminders', run: runPaymentDueReminders },
  { jobName: 'payment-due-cancellations', run: runPaymentDueCancellations },
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
  'side-effects-dispatcher',
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
    case 'side-effects-dispatcher':
      return runSideEffectsOutbox(ctx);
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

// ── Intent wrappers (kept for operational clarity) ─────────────────────────

export async function runCheckoutExpiry(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, 'checkout-expiry', ['expire_booking']);
}

async function runUnconfirmedFollowups(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, 'unconfirmed-followups', ['send_slot_reservation_reminder']);
}

export async function runPaymentDueReminders(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, 'payment-due-reminders', ['send_payment_reminder']);
}

export async function runPaymentDueCancellations(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, 'payment-due-cancellations', ['expire_booking']);
}

export async function run24hReminders(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, '24h-reminders', ['send_date_reminder']);
}

async function runSideEffectsByIntent(
  ctx: JobContext,
  jobName: string,
  intents: BookingEffectIntent[],
): Promise<void> {
  logJobStarted(ctx, jobName);

  const nowIso = new Date().toISOString();
  const effects = await ctx.providers.repository.getPendingBookingSideEffects(100, nowIso);
  const selected = effects.filter((effect) => intents.includes(effect.effect_intent));

  let succeeded = 0;
  let failed = 0;

  for (const effect of selected) {
    try {
      const outcome = await dispatchSideEffect(effect, ctx, nowIso);
      if (outcome === 'skipped') continue;
      succeeded++;
    } catch (error) {
      failed++;
      await ctx.providers.repository.logFailure({
        source: 'job',
        operation: jobName,
        booking_id: effect.booking_id,
        request_id: ctx.requestId,
        error_message: String(error),
        context: {
          job_name: jobName,
          trigger_source: ctx.triggerSource,
          effect_intent: effect.effect_intent,
          side_effect_id: effect.id,
        },
      });
    }
  }

  logJobCompleted(ctx, jobName, {
    items_found: selected.length,
    items_processed: selected.length,
    items_succeeded: succeeded,
    items_failed: failed,
  });
}

// ── Job: side-effects outbox dispatcher ─────────────────────────────────────

export async function runSideEffectsOutbox(ctx: JobContext): Promise<void> {
  const jobName = 'side-effects-dispatcher';
  logJobStarted(ctx, jobName);

  const nowIso = new Date().toISOString();
  await ctx.providers.repository.markStaleProcessingSideEffectsAsPending(nowIso);

  const effects = await ctx.providers.repository.getPendingBookingSideEffects(50, nowIso);
  let succeeded = 0;
  let failed = 0;

  for (const effect of effects) {
    try {
      const outcome = await dispatchSideEffect(effect, ctx, nowIso);
      if (outcome === 'skipped') continue;
      succeeded++;
    } catch (error) {
      failed++;
      await ctx.providers.repository.logFailure({
        source: 'job',
        operation: 'side-effects-dispatcher',
        booking_id: effect.booking_id,
        request_id: ctx.requestId,
        error_message: String(error),
        context: {
          job_name: jobName,
          trigger_source: ctx.triggerSource,
          effect_intent: effect.effect_intent,
          side_effect_id: effect.id,
        },
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

async function dispatchSideEffect(
  effect: BookingSideEffect & { booking_id: string },
  ctx: JobContext,
  nowIso: string,
): Promise<'processed' | 'skipped'> {
  const timing = sideEffectTiming(effect, nowIso);
  if (timing === 'wait') return 'skipped';

  const lastAttempt = await ctx.providers.repository.getLastBookingSideEffectAttempt(effect.id);
  const attemptNum = (lastAttempt?.attempt_num ?? 0) + 1;
  const apiLogId = crypto.randomUUID();

  if (timing === 'expired') {
    await ctx.providers.repository.createBookingSideEffectAttempt({
      booking_side_effect_id: effect.id,
      attempt_num: attemptNum,
      api_log_id: apiLogId,
      status: 'fail',
      error_message: 'expired_without_execution',
    });
    await ctx.providers.repository.updateBookingSideEffect(effect.id, { status: 'dead', updated_at: nowIso });
    return 'processed';
  }

  await ctx.providers.repository.updateBookingSideEffect(effect.id, { status: 'processing', updated_at: nowIso });

  try {
    await executeSideEffect(effect, ctx);

    await ctx.providers.repository.createBookingSideEffectAttempt({
      booking_side_effect_id: effect.id,
      attempt_num: attemptNum,
      api_log_id: apiLogId,
      status: 'success',
      error_message: null,
    });

    await ctx.providers.repository.updateBookingSideEffect(effect.id, { status: 'success', updated_at: new Date().toISOString() });
    return 'processed';
  } catch (error) {
    const errorMessage = String(error);

    await ctx.providers.repository.createBookingSideEffectAttempt({
      booking_side_effect_id: effect.id,
      attempt_num: attemptNum,
      api_log_id: apiLogId,
      status: 'fail',
      error_message: errorMessage,
    });

    const nextStatus = sideEffectStatusAfterAttempt('fail', attemptNum, effect.max_attempts);
    await ctx.providers.repository.updateBookingSideEffect(effect.id, { status: nextStatus, updated_at: new Date().toISOString() });
    throw error;
  }
}

function sideEffectTiming(
  effect: BookingSideEffect & { booking_id: string },
  nowIso: string,
): 'run' | 'wait' | 'expired' {
  if (!effect.expires_at) return 'run';

  const nowMs = new Date(nowIso).getTime();
  const expiresMs = new Date(effect.expires_at).getTime();
  const nowAfterExpiry = nowMs >= expiresMs;

  switch (effect.effect_intent) {
    case 'expire_booking':
    case 'send_payment_reminder':
    case 'send_date_reminder':
    case 'send_slot_reservation_reminder':
      return nowAfterExpiry ? 'run' : 'wait';
    default:
      return nowAfterExpiry ? 'expired' : 'run';
  }
}

async function executeSideEffect(
  effect: BookingSideEffect & { booking_id: string },
  ctx: JobContext,
): Promise<void> {
  const booking = await ctx.providers.repository.getBookingById(effect.booking_id);
  if (!booking) {
    throw new Error(`booking_not_found:${effect.booking_id}`);
  }

  const bookingCtx = {
    providers: ctx.providers,
    env: ctx.env,
    logger: ctx.logger,
    requestId: ctx.requestId,
  };

  switch (effect.effect_intent) {
    case 'send_email_confirmation': {
      const bookingEvent = await ctx.providers.repository.getBookingEventById(effect.booking_event_id);
      const confirmToken = typeof bookingEvent?.payload?.['confirm_token'] === 'string'
        ? bookingEvent.payload['confirm_token'] as string
        : null;
      if (!confirmToken) {
        throw new Error('confirm_token_missing');
      }

      const confirmUrl = buildConfirmUrl(ctx.env.SITE_URL, confirmToken);
      if (booking.event_id) {
        const event = await ctx.providers.repository.getEventById(booking.event_id);
        if (!event) throw new Error('event_not_found');
        await ctx.providers.email.sendEventConfirmRequest(booking, event, confirmUrl);
      } else {
        await ctx.providers.email.sendBookingConfirmRequest(booking, confirmUrl);
      }
      return;
    }

    case 'send_slot_reservation_reminder': {
      await sendPendingBookingFollowup(booking, bookingCtx);
      return;
    }

    case 'send_payment_reminder': {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      const payUrl = payment?.checkout_url;
      if (!payUrl) throw new Error('checkout_url_missing');

      if (!booking.event_id) {
        await ctx.providers.email.sendBookingPaymentReminder(booking, payUrl);
      } else {
        const event = await ctx.providers.repository.getEventById(booking.event_id);
        if (!event) throw new Error('event_not_found');
        await ctx.providers.email.sendEventFollowup(booking, event, payUrl);
      }

      await ctx.providers.repository.createBookingEvent({
        booking_id: booking.id,
        event_type: 'PAYMENT_REMINDER_SENT',
        source: 'job',
        payload: { side_effect_id: effect.id },
      });
      return;
    }

    case 'send_date_reminder': {
      await send24hBookingReminder(booking, bookingCtx);
      return;
    }

    case 'send_booking_failed_notification':
    case 'send_booking_cancellation_confirmation': {
      await ctx.providers.email.sendBookingCancellation(booking);
      return;
    }

    case 'reserve_slot':
      await retryCalendarSyncForBooking(booking, 'create', bookingCtx);
      return;

    case 'update_reserved_slot':
      await retryCalendarSyncForBooking(booking, 'update', bookingCtx);
      return;

    case 'cancel_reserved_slot':
      await retryCalendarSyncForBooking(booking, 'delete', bookingCtx);
      return;

    case 'confirm_reserved_slot': {
      await retryCalendarSyncForBooking(booking, 'update', bookingCtx);
      if (!['EXPIRED', 'CANCELED', 'CLOSED'].includes(booking.current_status)) {
        await appendBookingEventWithEffects(
          booking.id,
          'SLOT_CONFIRMED',
          'system',
          { via_effect_intent: effect.effect_intent },
          bookingCtx,
        );
      }
      return;
    }

    case 'create_stripe_checkout': {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      if (!payment?.checkout_url) {
        throw new Error('checkout_not_initialized');
      }
      return;
    }

    case 'verify_stripe_payment':
      return;

    case 'send_payment_link': {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      const payUrl = payment?.checkout_url;
      if (!payUrl) throw new Error('checkout_url_missing');
      const manageUrl = await buildManageUrl(ctx.env.SITE_URL, booking);
      await ctx.providers.email.sendBookingPaymentDue(booking, payUrl, manageUrl);
      return;
    }

    case 'expire_booking': {
      if (booking.current_status !== 'PENDING_CONFIRMATION') return;
      await expireBooking(booking, bookingCtx);
      return;
    }

    case 'close_booking': {
      if (booking.current_status === 'CLOSED') return;
      await ctx.providers.repository.updateBooking(booking.id, { current_status: 'CLOSED' as BookingCurrentStatus });
      await ctx.providers.repository.createBookingEvent({
        booking_id: booking.id,
        event_type: 'BOOKING_CLOSED',
        source: 'job',
        payload: {},
      });
      return;
    }

    default:
      throw new Error(`unknown_effect_intent:${effect.effect_intent}`);
  }
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
    } catch (error) {
      failed++;
      await providers.repository.logFailure({
        source: 'job',
        operation: 'calendar-sync-retries',
        booking_id: failure.booking_id,
        request_id: ctx.requestId,
        error_message: String(error),
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
