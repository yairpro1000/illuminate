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
  applyImmediateNonCronSideEffectsForTransition,
  buildContinuePaymentUrl,
  buildConfirmUrl,
  buildManageUrl,
  expireBooking,
  retryCalendarSyncForBooking,
  send24hBookingReminder,
  sendBookingFinalConfirmation,
} from '../services/booking-service.js';
import { appendBookingEventWithEffects } from '../services/booking-transition.js';
import { sideEffectStatusAfterAttempt } from '../providers/repository/interface.js';
import type { BookingCurrentStatus, BookingEffectIntent, BookingSideEffect } from '../types.js';
import { getBookingPolicyConfig } from '../domain/booking-effect-policy.js';
import {
  isPaymentContinuableOnline,
  isPaymentManualArrangementStatus,
  isPaymentSettledStatus,
} from '../domain/payment-status.js';

export interface JobContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
  correlationId?: string;
  operation?: OperationContext;
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
const CRON_OWNED_SIDE_EFFECT_INTENTS: ReadonlySet<BookingEffectIntent> = new Set([
  'SEND_PAYMENT_LINK',
  'SEND_PAYMENT_REMINDER',
  'SEND_EVENT_REMINDER',
  'VERIFY_EMAIL_CONFIRMATION',
  'VERIFY_STRIPE_PAYMENT',
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
    correlationId: ctx.correlationId,
    operation: ctx.operation,
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

  const relevance = await evaluateSideEffectRelevance(effect, ctx);
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

  const attemptNum = (lastAttempt?.attempt_num ?? 0) + 1;
  const apiLogId = null;
  if (ctx.operation) {
    extendOperationContext(ctx.operation, {
      bookingId: effect.booking_id,
      sideEffectId: effect.id,
      latestProviderApiLogId: null,
    });
  }

  if (timing === 'expired') {
    const createdAttempt = await ctx.providers.repository.createBookingSideEffectAttempt({
      booking_side_effect_id: effect.id,
      attempt_num: attemptNum,
      api_log_id: apiLogId,
      status: 'FAILED',
      error_message: 'expired_without_execution',
    });
    if (ctx.operation) {
      extendOperationContext(ctx.operation, {
        sideEffectId: effect.id,
        sideEffectAttemptId: createdAttempt.id,
      });
    }
    await syncApiLogOperationReferences(ctx.env, apiLogId, ctx.operation);
    await ctx.providers.repository.updateBookingSideEffect(effect.id, { status: 'DEAD', updated_at: nowIso });
    return 'processed';
  }

  await ctx.providers.repository.updateBookingSideEffect(effect.id, { status: 'PROCESSING', updated_at: nowIso });

  try {
    await executeSideEffect(effect, ctx);
    const providerApiLogId = consumeLatestProviderApiLogId(ctx.operation);

    const createdAttempt = await ctx.providers.repository.createBookingSideEffectAttempt({
      booking_side_effect_id: effect.id,
      attempt_num: attemptNum,
      api_log_id: providerApiLogId ?? apiLogId,
      status: 'SUCCESS',
      error_message: null,
    });
    if (ctx.operation) {
      extendOperationContext(ctx.operation, {
        sideEffectId: effect.id,
        sideEffectAttemptId: createdAttempt.id,
      });
    }
    await syncApiLogOperationReferences(ctx.env, providerApiLogId ?? apiLogId, ctx.operation);

    await ctx.providers.repository.updateBookingSideEffect(effect.id, { status: 'SUCCESS', updated_at: new Date().toISOString() });
    return 'processed';
  } catch (error) {
    const errorMessage = String(error);

    if (
      errorMessage === 'Error: irrelevant_payment_link_already_settled'
      || errorMessage === 'Error: irrelevant_payment_link_manual_arrangement'
    ) {
      await ctx.providers.repository.deleteBookingSideEffect(effect.id);
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

    const providerApiLogId = consumeLatestProviderApiLogId(ctx.operation) ?? apiLogId;
    const createdAttempt = await ctx.providers.repository.createBookingSideEffectAttempt({
      booking_side_effect_id: effect.id,
      attempt_num: attemptNum,
      api_log_id: providerApiLogId,
      status: 'FAILED',
      error_message: errorMessage,
    });
    if (ctx.operation) {
      extendOperationContext(ctx.operation, {
        sideEffectId: effect.id,
        sideEffectAttemptId: createdAttempt.id,
      });
    }
    await syncApiLogOperationReferences(ctx.env, providerApiLogId, ctx.operation);

    const nextStatus = sideEffectStatusAfterAttempt('FAILED', attemptNum, effect.max_attempts);
    await ctx.providers.repository.updateBookingSideEffect(effect.id, { status: nextStatus, updated_at: new Date().toISOString() });
    throw error;
  }
}

async function evaluateSideEffectRelevance(
  effect: BookingSideEffect & { booking_id: string },
  ctx: JobContext,
): Promise<{
  shouldProcess: boolean;
  branchTaken: string;
  denyReason: string | null;
  context: Record<string, unknown>;
}> {
  switch (effect.effect_intent) {
    case 'SEND_PAYMENT_LINK': {
      const payment = await ctx.providers.repository.getPaymentByBookingId(effect.booking_id);
      const paymentStatus = payment?.status ?? null;
      const alreadySettled = isPaymentSettledStatus(paymentStatus);
      const manualArrangement = isPaymentManualArrangementStatus(paymentStatus);
      return {
        shouldProcess: !alreadySettled && !manualArrangement,
        branchTaken: alreadySettled
          ? 'deny_irrelevant_payment_link_already_settled'
          : manualArrangement
            ? 'deny_irrelevant_payment_link_manual_arrangement'
            : 'allow_payment_link_effect',
        denyReason: alreadySettled
          ? 'payment_already_settled'
          : manualArrangement
            ? 'manual_payment_arrangement_active'
            : null,
        context: {
          payment_status: paymentStatus,
          has_payment_url: Boolean(payment?.invoice_url ?? payment?.checkout_url),
        },
      };
    }
    case 'SEND_PAYMENT_REMINDER':
    case 'VERIFY_STRIPE_PAYMENT': {
      const payment = await ctx.providers.repository.getPaymentByBookingId(effect.booking_id);
      const paymentStatus = payment?.status ?? null;
      const manualArrangement = isPaymentManualArrangementStatus(paymentStatus);
      return {
        shouldProcess: !manualArrangement,
        branchTaken: manualArrangement
          ? `deny_irrelevant_${effect.effect_intent.toLowerCase()}_manual_arrangement`
          : 'allow_payment_followup_effect',
        denyReason: manualArrangement ? 'manual_payment_arrangement_active' : null,
        context: {
          payment_status: paymentStatus,
        },
      };
    }
    default:
      return {
        shouldProcess: true,
        branchTaken: 'allow_non_guarded_effect',
        denyReason: null,
        context: {},
      };
  }
}

function evaluateSweeperDispatchDecision(
  effect: Pick<BookingSideEffect, 'effect_intent' | 'status' | 'created_at' | 'updated_at'>,
  lastAttempt: { attempt_num: number } | null,
): {
  shouldDispatch: boolean;
  branchTaken: string;
  denyReason: string | null;
} {
  if (effect.status === 'FAILED') {
    return {
      shouldDispatch: true,
      branchTaken: 'dispatch_failed_effect_retry',
      denyReason: null,
    };
  }

  if (CRON_OWNED_SIDE_EFFECT_INTENTS.has(effect.effect_intent)) {
    return {
      shouldDispatch: true,
      branchTaken: 'dispatch_cron_owned_effect',
      denyReason: null,
    };
  }

  if (lastAttempt) {
    return {
      shouldDispatch: true,
      branchTaken: 'dispatch_pending_effect_with_attempt_history',
      denyReason: null,
    };
  }

  const wasPreviouslyTouched = new Date(effect.updated_at).getTime() > new Date(effect.created_at).getTime();
  if (wasPreviouslyTouched) {
    return {
      shouldDispatch: true,
      branchTaken: 'dispatch_stale_recovered_pending_effect',
      denyReason: null,
    };
  }

  return {
    shouldDispatch: false,
    branchTaken: 'skip_pending_non_cron_first_attempt',
    denyReason: 'non_cron_side_effect_must_execute_realtime',
  };
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
    case 'SEND_PAYMENT_LINK':
    case 'SEND_PAYMENT_REMINDER':
    case 'SEND_EVENT_REMINDER':
    case 'VERIFY_EMAIL_CONFIRMATION':
    case 'VERIFY_STRIPE_PAYMENT':
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
    correlationId: ctx.correlationId,
    operation: ctx.operation,
  };

  switch (effect.effect_intent) {
    case 'SEND_BOOKING_CONFIRMATION_REQUEST': {
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
        const policy = await getBookingPolicyConfig(ctx.providers.repository);
        await ctx.providers.email.sendBookingConfirmRequest(
          booking,
          confirmUrl,
          policy.nonPaidConfirmationWindowMinutes,
        );
      }
      return;
    }

    case 'SEND_PAYMENT_REMINDER': {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      const payUrl = (payment?.invoice_url ?? payment?.checkout_url)
        ? buildContinuePaymentUrl(ctx.env.SITE_URL, booking)
        : null;
      if (!payUrl) throw new Error('checkout_url_missing');

      if (!booking.event_id) {
        await ctx.providers.email.sendBookingPaymentReminder(booking, payUrl);
      } else {
        const event = await ctx.providers.repository.getEventById(booking.event_id);
        if (!event) throw new Error('event_not_found');
        await ctx.providers.email.sendEventFollowup(booking, event, payUrl);
      }

      return;
    }

    case 'SEND_EVENT_REMINDER': {
      await send24hBookingReminder(booking, bookingCtx);
      return;
    }

    case 'SEND_BOOKING_EXPIRATION_NOTIFICATION': {
      await ctx.providers.email.sendBookingExpired(booking, buildStartNewBookingUrl(ctx.env.SITE_URL, booking));
      return;
    }

    case 'SEND_BOOKING_CANCELLATION_CONFIRMATION': {
      await ctx.providers.email.sendBookingCancellation(booking, null);
      return;
    }

    case 'SEND_BOOKING_CONFIRMATION': {
      await sendBookingFinalConfirmation(booking, bookingCtx);
      return;
    }

    case 'RESERVE_CALENDAR_SLOT': {
      const result = await retryCalendarSyncForBooking(booking, 'create', bookingCtx);
      if (!result.calendarSynced) {
        throw new Error(result.failureReason ?? 'calendar_sync_failed');
      }
      return;
    }

    case 'UPDATE_CALENDAR_SLOT': {
      const result = await retryCalendarSyncForBooking(booking, 'update', bookingCtx);
      if (!result.calendarSynced) {
        throw new Error(result.failureReason ?? 'calendar_sync_failed');
      }
      return;
    }

    case 'CANCEL_CALENDAR_SLOT': {
      const result = await retryCalendarSyncForBooking(booking, 'delete', bookingCtx);
      if (!result.calendarSynced) {
        throw new Error(result.failureReason ?? 'calendar_sync_failed');
      }
      return;
    }

    case 'CREATE_STRIPE_CHECKOUT': {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      if (!payment?.checkout_url) {
        throw new Error('checkout_not_initialized');
      }
      return;
    }

    case 'VERIFY_STRIPE_PAYMENT': {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      if (isPaymentSettledStatus(payment?.status)) {
        const settledPayment = payment!;
        await appendBookingEventWithEffects(
          booking.id,
          'PAYMENT_SETTLED',
          'SYSTEM',
          { side_effect_id: effect.id, provider_payment_id: settledPayment.provider_payment_id },
          bookingCtx,
        );
        return;
      }
      if (booking.current_status === 'PENDING') {
        await expireBooking(booking, bookingCtx);
      }
      return;
    }

    case 'SEND_PAYMENT_LINK': {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      const payUrl = payment?.invoice_url ?? payment?.checkout_url;
      if (!payUrl) throw new Error('checkout_url_missing');
      const alreadySettled = isPaymentSettledStatus(payment?.status);
      const manualArrangement = isPaymentManualArrangementStatus(payment?.status);
      ctx.logger.logInfo({
        source: jobLogSource(ctx),
        eventType: 'checkout_followup_payment_link_decision',
        message: 'Evaluated checkout follow-up payment link delivery',
        context: {
          booking_id: booking.id,
          side_effect_id: effect.id,
          payment_status: payment?.status ?? null,
          has_checkout_url: Boolean(payUrl),
          should_send_payment_link: !alreadySettled && !manualArrangement,
          branch_taken: alreadySettled
            ? 'skip_payment_link_already_settled'
            : manualArrangement
              ? 'skip_payment_link_manual_arrangement'
              : 'send_payment_link_email',
          deny_reason: alreadySettled
            ? 'payment_already_settled'
            : manualArrangement
              ? 'manual_payment_arrangement_active'
              : null,
        },
      });

      if (alreadySettled) {
        throw new Error('irrelevant_payment_link_already_settled');
      }
      if (manualArrangement) {
        throw new Error('irrelevant_payment_link_manual_arrangement');
      }

      const manageUrl = await buildManageUrl(ctx.env.SITE_URL, booking);
      const policy = await getBookingPolicyConfig(ctx.providers.repository);
      await ctx.providers.email.sendBookingPaymentDue(
        booking,
        buildContinuePaymentUrl(ctx.env.SITE_URL, booking),
        manageUrl,
        new Date(
          new Date(booking.starts_at).getTime() - policy.paymentDueBeforeStartHours * 60 * 60 * 1000,
        ).toISOString(),
      );
      ctx.logger.logInfo({
        source: jobLogSource(ctx),
        eventType: 'checkout_followup_payment_link_sent',
        message: 'Checkout follow-up payment link sent',
        context: {
          booking_id: booking.id,
          side_effect_id: effect.id,
          payment_status: payment?.status ?? null,
          branch_taken: 'payment_link_sent',
        },
      });
      return;
    }

    case 'VERIFY_EMAIL_CONFIRMATION': {
      if (booking.current_status === 'PENDING') {
        await expireBooking(booking, bookingCtx);
      }
      return;
    }

    default:
      throw new Error(`unknown_effect_intent:${effect.effect_intent}`);
  }
}

function buildStartNewBookingUrl(siteUrl: string, booking: { event_id: string | null }): string {
  const base = siteUrl.replace(/\/+$/g, '');
  return booking.event_id ? `${base}/evenings.html` : `${base}/sessions.html`;
}
