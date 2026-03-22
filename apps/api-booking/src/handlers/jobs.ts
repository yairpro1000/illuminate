/**
 * Scheduled job implementations for the booking event/side-effect model.
 */

import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { AppContext } from '../router.js';
import { consumeLatestProviderApiLogId, extendOperationContext, type OperationContext } from '../lib/execution.js';
import { ok, unauthorized } from '../lib/errors.js';
import { syncApiLogOperationReferences } from '../lib/technical-observability.js';
import {
  buildContinuePaymentUrl,
  buildConfirmUrl,
  buildManageUrl,
  executeBookingSideEffectAction,
  expireBooking,
  retryCalendarSyncForBooking,
  send24hBookingReminder,
  sendBookingCancellationConfirmation,
  sendBookingFinalConfirmation,
} from '../services/booking-service.js';
import {
  initiateAutomaticCancellationRefund,
  sendRefundConfirmationEmailForBooking,
} from '../services/refund-service.js';
import {
  expireBookingSideEffectWithoutExecution,
  finalizeBookingEventStatus,
  runBookingEventEffects,
} from '../services/booking-event-workflow.js';
import { appendBookingEventWithEffects } from '../services/booking-transition.js';
import { isRetryableCalendarWriteError, RetryableCalendarWriteError } from '../providers/calendar/interface.js';
import type { BookingCurrentStatus, BookingEffectIntent, BookingSideEffect } from '../types.js';
import { getBookingPolicyConfig } from '../domain/booking-effect-policy.js';
import { isPaymentContinuableOnline } from '../domain/payment-status.js';
import {
  evaluateSideEffectRelevance,
  evaluateSweeperDispatchDecision,
  sideEffectTiming,
} from '../domain/booking-side-effect-policy.js';

export interface JobContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
  correlationId?: string;
  operation?: OperationContext;
  siteUrl?: string;
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
  { jobName: 'checkout-followups', run: runCheckoutFollowups },
  { jobName: 'checkout-expiry', run: runCheckoutExpiry },
  { jobName: 'unconfirmed-followups', run: runUnconfirmedFollowups },
  { jobName: 'payment-due-reminders', run: runPaymentDueReminders },
  { jobName: 'payment-due-cancellations', run: runPaymentDueCancellations },
  { jobName: '24h-reminders', run: run24hReminders },
  { jobName: 'side-effects-dispatcher', run: runSideEffectsOutbox },
];

const MANUAL_JOB_NAMES = new Set([
  'checkout-followups',
  'checkout-expiry',
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

function toBookingContext(ctx: JobContext) {
  return {
    providers: ctx.providers,
    env: ctx.env,
    logger: ctx.logger,
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    operation: ctx.operation,
    siteUrl: ctx.siteUrl,
  };
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
    correlationId: ctx.correlationId,
    operation: ctx.operation,
    siteUrl: ctx.siteUrl,
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
    case 'checkout-followups':
      return runCheckoutFollowups(ctx);
    case 'checkout-expiry':
      return runCheckoutExpiry(ctx);
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
          status: 'SUCCESS',
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
          status: 'FAILED',
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

export async function runCheckoutFollowups(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, 'checkout-followups', ['SEND_PAYMENT_LINK']);
}

export async function runCheckoutExpiry(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, 'checkout-expiry', ['VERIFY_STRIPE_PAYMENT']);
}

async function runUnconfirmedFollowups(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, 'unconfirmed-followups', ['VERIFY_EMAIL_CONFIRMATION']);
}

export async function runPaymentDueReminders(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, 'payment-due-reminders', ['SEND_PAYMENT_REMINDER']);
}

export async function runPaymentDueCancellations(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, 'payment-due-cancellations', ['VERIFY_STRIPE_PAYMENT']);
}

export async function run24hReminders(ctx: JobContext): Promise<void> {
  await runSideEffectsByIntent(ctx, '24h-reminders', ['SEND_EVENT_REMINDER']);
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
      ctx.logger.logError({
        source: jobLogSource(ctx),
        eventType: 'side_effect_dispatch_failure',
        message: 'Side effect dispatch failed',
        context: {
          job_name: jobName,
          trigger_source: ctx.triggerSource,
          booking_id: effect.booking_id,
          effect_intent: effect.effect_intent,
          side_effect_id: effect.id,
          error: String(error),
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
      ctx.logger.logError({
        source: jobLogSource(ctx),
        eventType: 'side_effect_dispatch_failure',
        message: 'Side effect dispatch failed',
        context: {
          job_name: jobName,
          trigger_source: ctx.triggerSource,
          booking_id: effect.booking_id,
          effect_intent: effect.effect_intent,
          side_effect_id: effect.id,
          error: String(error),
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
  const lastAttempt = await ctx.providers.repository.getLastBookingSideEffectAttempt(effect.id);
  const dispatchDecision = evaluateSweeperDispatchDecision(effect, lastAttempt);

  ctx.logger.logInfo({
    source: jobLogSource(ctx),
    eventType: 'side_effect_sweeper_dispatch_decision',
    message: 'Evaluated whether sweeper should dispatch side effect',
    context: {
      trigger_source: ctx.triggerSource,
      booking_id: effect.booking_id,
      side_effect_id: effect.id,
      side_effect_intent: effect.effect_intent,
      side_effect_status: effect.status,
      side_effect_expires_at: effect.expires_at,
      last_attempt_num: lastAttempt?.attempt_num ?? null,
      should_dispatch: dispatchDecision.shouldDispatch,
      branch_taken: dispatchDecision.branchTaken,
      deny_reason: dispatchDecision.denyReason,
    },
  });

  if (!dispatchDecision.shouldDispatch) {
    return 'skipped';
  }

  const timing = sideEffectTiming(effect, nowIso);
  if (timing === 'wait') return 'skipped';

  const relevance = await evaluateSideEffectRelevance(effect, ctx.providers.repository);
  ctx.logger.logInfo({
    source: jobLogSource(ctx),
    eventType: 'side_effect_relevance_decision',
    message: 'Evaluated side effect relevance before persistence writes',
    context: {
      trigger_source: ctx.triggerSource,
      booking_id: effect.booking_id,
      side_effect_id: effect.id,
      side_effect_intent: effect.effect_intent,
      should_process: relevance.shouldProcess,
      branch_taken: relevance.branchTaken,
      deny_reason: relevance.denyReason,
      ...relevance.context,
    },
  });

  if (!relevance.shouldProcess) {
    await ctx.providers.repository.deleteBookingSideEffect(effect.id);
    await finalizeBookingEventStatus(effect.booking_event_id, toBookingContext(ctx));
    ctx.logger.logInfo({
      source: jobLogSource(ctx),
      eventType: 'side_effect_irrelevant_discarded',
      message: 'Discarded irrelevant side effect before booking-event/attempt writes',
      context: {
        trigger_source: ctx.triggerSource,
        booking_id: effect.booking_id,
        side_effect_id: effect.id,
        side_effect_intent: effect.effect_intent,
        branch_taken: 'discard_irrelevant_side_effect',
        deny_reason: relevance.denyReason,
        ...relevance.context,
      },
    });
    return 'skipped';
  }

  if (ctx.operation) {
    extendOperationContext(ctx.operation, {
      bookingId: effect.booking_id,
      sideEffectId: effect.id,
      latestProviderApiLogId: null,
    });
  }

  const booking = await ctx.providers.repository.getBookingById(effect.booking_id);
  if (!booking) {
    throw new Error(`booking_not_found:${effect.booking_id}`);
  }
  const bookingEvent = await ctx.providers.repository.getBookingEventById(effect.booking_event_id);
  if (!bookingEvent) {
    throw new Error(`booking_event_not_found:${effect.booking_event_id}`);
  }
  const bookingCtx = toBookingContext(ctx);

  if (timing === 'expired') {
    await expireBookingSideEffectWithoutExecution(
      {
        booking,
        event: bookingEvent,
        effect,
        sourceOperation: `run_side_effects_outbox:${effect.effect_intent}`,
        triggerSource: 'cron',
        errorMessage: 'expired_without_execution',
      },
      bookingCtx,
    );
    return 'processed';
  }

  try {
    await runBookingEventEffects(
      {
        booking,
        event: bookingEvent,
        sideEffects: [effect],
        sourceOperation: `run_side_effects_outbox:${effect.effect_intent}`,
        triggerSource: 'cron',
        executeEffect: executeBookingSideEffectAction,
      },
      bookingCtx,
    );
    return 'processed';
  } catch (error) {
    const errorMessage = error instanceof Error && error.message
      ? error.message
      : String(error);

    if (
      errorMessage === 'Error: irrelevant_payment_link_already_settled'
      || errorMessage === 'Error: irrelevant_payment_link_manual_arrangement'
    ) {
      await ctx.providers.repository.deleteBookingSideEffect(effect.id);
      await finalizeBookingEventStatus(effect.booking_event_id, bookingCtx, {
        startedExecution: true,
        failureMessage: null,
      });
      ctx.logger.logInfo({
        source: jobLogSource(ctx),
        eventType: 'side_effect_irrelevant_discarded',
        message: 'Discarded irrelevant side effect during execution guard',
        context: {
          trigger_source: ctx.triggerSource,
          booking_id: effect.booking_id,
          side_effect_id: effect.id,
          side_effect_intent: effect.effect_intent,
          branch_taken: 'discard_irrelevant_side_effect_runtime_guard',
          deny_reason: errorMessage === 'Error: irrelevant_payment_link_already_settled'
            ? 'payment_already_settled'
            : 'manual_payment_arrangement_active',
        },
      });
      return 'skipped';
    }
    throw error;
  }
}
