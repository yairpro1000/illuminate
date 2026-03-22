import { consumeLatestProviderApiLogId, extendOperationContext } from '../lib/execution.js';
import { syncApiLogOperationReferences } from '../lib/technical-observability.js';
import { resolveSideEffectAttemptOutcome } from '../domain/booking-effect-policy.js';
import { getBookingPolicyConfig } from '../config/booking-policy.js';
import { sideEffectStatusAfterAttempt } from '../providers/repository/interface.js';
import type {
  Booking,
  BookingEventRecord,
  BookingEventStatus,
  BookingSideEffect,
  BookingSideEffectAttempt,
} from '../types.js';
import type { BookingContext } from './booking-service.js';

export interface BookingEventEffectResult {
  effectId: string;
  effectIntent: BookingSideEffect['effect_intent'];
  booking: Booking;
  metadata: Record<string, unknown> | null;
  outcome: 'SUCCESS' | 'FAILED';
}

export interface BookingEventExecutionResult {
  booking: Booking;
  event: BookingEventRecord;
  sideEffects: BookingSideEffect[];
  effectResults: BookingEventEffectResult[];
}

export interface BookingSideEffectExecutorInput {
  booking: Booking;
  event: BookingEventRecord;
  effect: BookingSideEffect;
  ctx: BookingContext;
  sourceOperation: string;
  triggerSource: 'realtime' | 'cron';
}

export interface BookingSideEffectExecutorResult {
  booking: Booking;
  metadata?: Record<string, unknown> | null;
  nextSideEffects?: BookingSideEffect[];
  handledFailure?: {
    errorMessage: string;
    enableCalendarBackoff?: boolean;
  } | null;
}

interface StartedAttempt {
  attempt: BookingSideEffectAttempt;
  attemptNum: number;
}

interface AttemptFinishInput {
  effect: BookingSideEffect;
  booking: Booking;
  attempt: StartedAttempt;
  status: 'SUCCESS' | 'FAILED';
  errorMessage: string | null;
  apiLogId: string | null;
  enableCalendarBackoff: boolean;
  logSource: 'backend' | 'cron' | 'worker';
}

export async function finalizeBookingEventStatus(
  eventId: string,
  ctx: BookingContext,
  options: {
    startedExecution?: boolean;
    failureMessage?: string | null;
  } = {},
): Promise<BookingEventRecord> {
  const event = await ctx.providers.repository.getBookingEventById(eventId);
  if (!event) throw new Error(`booking_event_not_found:${eventId}`);
  await reconcileStuckProcessingSideEffects(event, ctx);
  let sideEffects = await ctx.providers.repository.listBookingSideEffectsForEvent(eventId);
  let nextStatus = deriveBookingEventStatus(sideEffects, options.startedExecution);
  let failureMessage = options.failureMessage ?? event.error_message;

  if (options.startedExecution && (nextStatus === 'PENDING' || nextStatus === 'PROCESSING')) {
    const policy = await getBookingPolicyConfig(ctx.providers.repository);
    const timeoutMs = policy.sideEffectProcessingTimeoutMinutes * 60_000;
    const elapsedMs = Date.now() - new Date(event.created_at).getTime();
    if (elapsedMs >= timeoutMs) {
      for (const effect of sideEffects) {
        if (effect.status === 'SUCCESS' || effect.status === 'DEAD') continue;
        await ctx.providers.repository.updateBookingSideEffect(effect.id, {
          status: 'DEAD',
          expires_at: null,
          updated_at: new Date().toISOString(),
        });
      }
      sideEffects = await ctx.providers.repository.listBookingSideEffectsForEvent(eventId);
      nextStatus = 'FAILED';
      failureMessage = failureMessage ?? 'booking_event_timed_out';
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'booking_event_timeout',
        message: 'Marked booking event as failed because side effects exceeded timeout',
        context: {
          booking_id: event.booking_id,
          booking_event_id: eventId,
          event_type: event.event_type,
          elapsed_ms: elapsedMs,
          timeout_ms: timeoutMs,
          branch_taken: 'mark_event_failed_on_timeout',
          deny_reason: 'booking_event_timed_out',
        },
      });
    }
  }

  const terminal = nextStatus === 'SUCCESS' || nextStatus === 'FAILED';
  return ctx.providers.repository.updateBookingEvent(eventId, {
    status: nextStatus,
    error_message: nextStatus === 'FAILED' ? failureMessage : null,
    completed_at: terminal ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  });
}

export async function runBookingEventEffects(
  input: {
    booking: Booking;
    event: BookingEventRecord;
    sideEffects: BookingSideEffect[];
    sourceOperation: string;
    triggerSource: 'realtime' | 'cron';
    executeEffect: (input: BookingSideEffectExecutorInput) => Promise<BookingSideEffectExecutorResult>;
  },
  ctx: BookingContext,
): Promise<BookingEventExecutionResult> {
  let currentBooking = input.booking;
  const effectResults: BookingEventEffectResult[] = [];
  const pendingEffects = [...input.sideEffects];
  const queuedEffectIds = new Set(input.sideEffects.map((effect) => effect.id));
  const eventsById = new Map<string, BookingEventRecord>([[input.event.id, input.event]]);
  const startedEventIds = new Set<string>();
  const workflowStartedAt = Date.now();

  if (pendingEffects.length === 0) {
    const finalizedEvent = await finalizeBookingEventStatus(input.event.id, ctx);
    return {
      booking: currentBooking,
      event: finalizedEvent,
      sideEffects: input.sideEffects,
      effectResults,
    };
  }

  async function resolveEventForEffect(effect: BookingSideEffect): Promise<BookingEventRecord> {
    const cached = eventsById.get(effect.booking_event_id);
    if (cached) return cached;
    const event = await ctx.providers.repository.getBookingEventById(effect.booking_event_id);
    if (!event) throw new Error(`booking_event_not_found:${effect.booking_event_id}`);
    eventsById.set(event.id, event);
    return event;
  }

  async function markEventExecutionStarted(eventId: string): Promise<void> {
    if (startedEventIds.has(eventId)) return;
    await ctx.providers.repository.updateBookingEvent(eventId, {
      status: 'PROCESSING',
      error_message: null,
      completed_at: null,
      updated_at: new Date().toISOString(),
    });
    startedEventIds.add(eventId);
  }

  while (pendingEffects.length > 0) {
    const effect = pendingEffects.shift();
    if (!effect) break;
    const effectEvent = await resolveEventForEffect(effect);
    await markEventExecutionStarted(effectEvent.id);
    const result = await executeBookingSideEffectLifecycle(
      {
        booking: currentBooking,
        event: effectEvent,
        effect,
        sourceOperation: input.sourceOperation,
        triggerSource: input.triggerSource,
        executeEffect: input.executeEffect,
      },
      ctx,
    );
    currentBooking = result.booking;
    effectResults.push(result.effectResult);
    for (const nextEffect of result.nextSideEffects) {
      if (queuedEffectIds.has(nextEffect.id)) continue;
      queuedEffectIds.add(nextEffect.id);
      pendingEffects.push(nextEffect);
    }
    const discoveredEffects = await discoverNewDispatchableSideEffects(
      currentBooking.id,
      workflowStartedAt,
      queuedEffectIds,
      ctx,
    );
    for (const discoveredEffect of discoveredEffects) {
      queuedEffectIds.add(discoveredEffect.id);
      pendingEffects.push(discoveredEffect);
    }
  }

  const finalEvents = new Map<string, BookingEventRecord>();
  for (const eventId of startedEventIds) {
    const finalized = await finalizeBookingEventStatus(eventId, ctx, { startedExecution: true });
    finalEvents.set(eventId, finalized);
  }
  const finalizedEvent = finalEvents.get(input.event.id)
    ?? await finalizeBookingEventStatus(input.event.id, ctx, { startedExecution: true });
  const refreshedEffects = await ctx.providers.repository.listBookingSideEffectsForEvent(input.event.id);
  return {
    booking: currentBooking,
    event: finalizedEvent,
    sideEffects: refreshedEffects,
    effectResults,
  };
}

async function discoverNewDispatchableSideEffects(
  bookingId: string,
  workflowStartedAtMs: number,
  queuedEffectIds: Set<string>,
  ctx: BookingContext,
): Promise<BookingSideEffect[]> {
  const events = await ctx.providers.repository.listBookingEvents(bookingId);
  if (events.length === 0) return [];

  const allEffectsNested = await Promise.all(
    events.map(async (event) => await ctx.providers.repository.listBookingSideEffectsForEvent(event.id)),
  );
  const nowMs = Date.now();
  const discovered: BookingSideEffect[] = [];

  for (const effects of allEffectsNested) {
    for (const effect of effects) {
      if (queuedEffectIds.has(effect.id)) continue;
      if (effect.status !== 'PENDING' && effect.status !== 'FAILED') continue;
      if (new Date(effect.created_at).getTime() < workflowStartedAtMs) continue;
      if (effect.expires_at) {
        const expiresAtMs = new Date(effect.expires_at).getTime();
        if (Number.isFinite(expiresAtMs) && expiresAtMs > nowMs) continue;
      }
      discovered.push(effect);
    }
  }

  return discovered;
}

export async function expireBookingSideEffectWithoutExecution(
  input: {
    booking: Booking;
    event: BookingEventRecord;
    effect: BookingSideEffect;
    sourceOperation: string;
    triggerSource: 'realtime' | 'cron';
    errorMessage: string;
  },
  ctx: BookingContext,
): Promise<BookingEventEffectResult> {
  const started = await startBookingSideEffectAttempt(input.effect, input.booking, input.event, ctx);
  await finishBookingSideEffectAttempt(
    {
      effect: input.effect,
      booking: input.booking,
      attempt: started,
      status: 'FAILED',
      errorMessage: input.errorMessage,
      apiLogId: null,
      enableCalendarBackoff: false,
      logSource: input.triggerSource === 'cron' ? 'cron' : 'backend',
    },
    ctx,
  );
  await finalizeBookingEventStatus(input.event.id, ctx, {
    startedExecution: true,
    failureMessage: input.errorMessage,
  });
  return {
    effectId: input.effect.id,
    effectIntent: input.effect.effect_intent,
    booking: input.booking,
    metadata: null,
    outcome: 'FAILED',
  };
}

async function executeBookingSideEffectLifecycle(
  input: {
    booking: Booking;
    event: BookingEventRecord;
    effect: BookingSideEffect;
    sourceOperation: string;
    triggerSource: 'realtime' | 'cron';
    executeEffect: (input: BookingSideEffectExecutorInput) => Promise<BookingSideEffectExecutorResult>;
  },
  ctx: BookingContext,
): Promise<{ booking: Booking; effectResult: BookingEventEffectResult; nextSideEffects: BookingSideEffect[] }> {
  const startedAttempt = await startBookingSideEffectAttempt(input.effect, input.booking, input.event, ctx);
  try {
    const executed = await input.executeEffect({
      booking: input.booking,
      event: input.event,
      effect: input.effect,
      ctx,
      sourceOperation: input.sourceOperation,
      triggerSource: input.triggerSource,
    });
    if (executed.handledFailure) {
      await completeAttemptWithGuaranteedPersistence(
        {
          effect: input.effect,
          booking: executed.booking,
          attempt: startedAttempt,
          status: 'FAILED',
          errorMessage: executed.handledFailure.errorMessage,
          apiLogId: consumeLatestProviderApiLogId(ctx.operation),
          enableCalendarBackoff: Boolean(executed.handledFailure.enableCalendarBackoff),
          logSource: input.triggerSource === 'cron' ? 'cron' : 'backend',
        },
        ctx,
      );
      return {
        booking: executed.booking,
        effectResult: {
          effectId: input.effect.id,
          effectIntent: input.effect.effect_intent,
          booking: executed.booking,
          metadata: executed.metadata ?? null,
          outcome: 'FAILED',
        },
        nextSideEffects: executed.nextSideEffects ?? [],
      };
    }
    const apiLogId = consumeLatestProviderApiLogId(ctx.operation);
    await completeAttemptWithGuaranteedPersistence(
      {
        effect: input.effect,
        booking: executed.booking,
        attempt: startedAttempt,
        status: 'SUCCESS',
        errorMessage: null,
        apiLogId,
        enableCalendarBackoff: false,
        logSource: input.triggerSource === 'cron' ? 'cron' : 'backend',
      },
      ctx,
    );
    const refreshedEffect = await ctx.providers.repository.getBookingSideEffectById(input.effect.id);
    if (refreshedEffect?.status === 'PROCESSING') {
      await ctx.providers.repository.updateBookingSideEffect(input.effect.id, {
        status: 'SUCCESS',
        expires_at: null,
        updated_at: new Date().toISOString(),
      });
      ctx.logger.logWarn?.({
        source: input.triggerSource === 'cron' ? 'cron' : 'backend',
        eventType: 'side_effect_processing_reconciled',
        message: 'Reconciled side effect stuck in PROCESSING immediately after successful attempt',
        context: {
          booking_id: executed.booking.id,
          booking_event_id: input.event.id,
          side_effect_id: input.effect.id,
          side_effect_intent: input.effect.effect_intent,
          branch_taken: 'reconcile_processing_to_success_after_successful_attempt',
          deny_reason: 'side_effect_stuck_processing',
        },
      });
    }
    return {
      booking: executed.booking,
      effectResult: {
        effectId: input.effect.id,
        effectIntent: input.effect.effect_intent,
        booking: executed.booking,
        metadata: executed.metadata ?? null,
        outcome: 'SUCCESS',
      },
      nextSideEffects: executed.nextSideEffects ?? [],
    };
  } catch (error) {
    const errorMessage = error instanceof Error && error.message ? error.message : String(error);
    const apiLogId = consumeLatestProviderApiLogId(ctx.operation);
    await completeAttemptWithGuaranteedPersistence(
      {
        effect: input.effect,
        booking: input.booking,
        attempt: startedAttempt,
        status: 'FAILED',
        errorMessage,
        apiLogId,
        enableCalendarBackoff: isRetryableCalendarWriteError(error),
        logSource: input.triggerSource === 'cron' ? 'cron' : 'backend',
      },
      ctx,
    );
    await finalizeBookingEventStatus(input.event.id, ctx, {
      startedExecution: true,
      failureMessage: errorMessage,
    });
    throw error;
  }
}

async function startBookingSideEffectAttempt(
  effect: BookingSideEffect,
  booking: Booking,
  event: BookingEventRecord,
  ctx: BookingContext,
): Promise<StartedAttempt> {
  const lastAttempt = await ctx.providers.repository.getLastBookingSideEffectAttempt(effect.id);
  const attemptNum = (lastAttempt?.attempt_num ?? 0) + 1;
  const attempt = await ctx.providers.repository.createBookingSideEffectAttempt({
    booking_side_effect_id: effect.id,
    attempt_num: attemptNum,
    api_log_id: null,
    status: 'FAILED',
    error_message: null,
    completed_at: null,
  });

  if (ctx.operation) {
    extendOperationContext(ctx.operation, {
      bookingId: booking.id,
      bookingEventId: event.id,
      sideEffectId: effect.id,
      sideEffectAttemptId: attempt.id,
      latestProviderApiLogId: null,
    });
  }

  try {
    await ctx.providers.repository.updateBookingSideEffect(effect.id, {
      status: 'PROCESSING',
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    const bootstrapError = error instanceof Error && error.message
      ? error.message
      : String(error);
    await ctx.providers.repository.updateBookingSideEffectAttempt(attempt.id, {
      status: 'FAILED',
      error_message: bootstrapError,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    ctx.logger.logError?.({
      source: 'backend',
      eventType: 'side_effect_attempt_bootstrap_failed',
      message: 'Failed to mark side effect as PROCESSING after inserting attempt row',
      context: {
        booking_id: booking.id,
        booking_event_id: event.id,
        side_effect_id: effect.id,
        side_effect_intent: effect.effect_intent,
        side_effect_attempt_id: attempt.id,
        side_effect_attempt_num: attemptNum,
        branch_taken: 'fail_attempt_bootstrap_after_insert',
        deny_reason: bootstrapError,
      },
    });
    throw error;
  }

  return { attempt, attemptNum };
}

async function finishBookingSideEffectAttempt(
  input: AttemptFinishInput,
  ctx: BookingContext,
): Promise<void> {
  const outcome = resolveSideEffectAttemptOutcome(
    {
      effectIntent: input.effect.effect_intent,
      maxAttempts: input.effect.max_attempts,
    },
    {
      attemptStatus: input.status,
      attemptNum: input.attempt.attemptNum,
      enableCalendarBackoff: input.enableCalendarBackoff,
    },
  );
  await ctx.providers.repository.updateBookingSideEffectAttempt(input.attempt.attempt.id, {
    api_log_id: input.apiLogId,
    status: input.status,
    error_message: input.errorMessage,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await syncApiLogOperationReferences(ctx.env, input.apiLogId, ctx.operation);
  await ctx.providers.repository.updateBookingSideEffect(input.effect.id, {
    status: outcome.nextStatus,
    expires_at: outcome.expiresAt,
    updated_at: new Date().toISOString(),
  });

  if (outcome.retryDelayMs !== null) {
    ctx.logger.logWarn?.({
      source: input.logSource,
      eventType: 'calendar_retry',
      message: 'Scheduled retry for calendar side effect after retryable provider failure',
      context: {
        booking_id: input.booking.id,
        effect_intent: input.effect.effect_intent,
        attempt: input.attempt.attemptNum,
        delay_ms: outcome.retryDelayMs,
        reason: input.errorMessage ?? 'calendar_sync_failed',
        request_id: ctx.requestId,
        branch_taken: 'schedule_retryable_calendar_side_effect_with_backoff',
        deny_reason: null,
      },
    });
  }
}

async function completeAttemptWithGuaranteedPersistence(
  input: AttemptFinishInput,
  ctx: BookingContext,
): Promise<void> {
  try {
    await finishBookingSideEffectAttempt(input, ctx);
  } catch (finalizationError) {
    const fallbackErrorMessage = input.errorMessage
      ?? (finalizationError instanceof Error && finalizationError.message
        ? finalizationError.message
        : String(finalizationError));

    await ctx.providers.repository.updateBookingSideEffectAttempt(input.attempt.attempt.id, {
      api_log_id: input.apiLogId,
      status: 'FAILED',
      error_message: fallbackErrorMessage,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    ctx.logger.logError?.({
      source: input.logSource,
      eventType: 'side_effect_attempt_finalization_failed',
      message: 'Primary side-effect finalization failed; wrote fallback failed-attempt state',
      context: {
        booking_id: input.booking.id,
        side_effect_id: input.effect.id,
        side_effect_intent: input.effect.effect_intent,
        side_effect_attempt_id: input.attempt.attempt.id,
        side_effect_attempt_num: input.attempt.attemptNum,
        branch_taken: 'fallback_finalize_attempt_as_failed',
        deny_reason: fallbackErrorMessage,
      },
    });

    throw finalizationError;
  }
}

function deriveBookingEventStatus(
  sideEffects: BookingSideEffect[],
  startedExecution = false,
): BookingEventStatus {
  if (sideEffects.length === 0) return 'SUCCESS';
  if (sideEffects.some((effect) => effect.status === 'DEAD')) return 'FAILED';
  if (sideEffects.every((effect) => effect.status === 'SUCCESS')) return 'SUCCESS';
  if (startedExecution) return 'PROCESSING';
  if (sideEffects.some((effect) => effect.status === 'PROCESSING' || effect.status === 'FAILED')) {
    return 'PROCESSING';
  }
  return 'PENDING';
}

function isRetryableCalendarWriteError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { name?: string }).name === 'RetryableCalendarWriteError';
}

async function reconcileStuckProcessingSideEffects(
  event: BookingEventRecord,
  ctx: BookingContext,
): Promise<void> {
  const sideEffects = await ctx.providers.repository.listBookingSideEffectsForEvent(event.id);
  for (const effect of sideEffects) {
    if (effect.status !== 'PROCESSING') continue;
    const lastAttempt = await ctx.providers.repository.getLastBookingSideEffectAttempt(effect.id);
    if (!lastAttempt) continue;
    if (lastAttempt.status === 'SUCCESS') {
      await ctx.providers.repository.updateBookingSideEffect(effect.id, {
        status: 'SUCCESS',
        expires_at: null,
        updated_at: new Date().toISOString(),
      });
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'side_effect_processing_reconciled',
        message: 'Reconciled stuck PROCESSING side effect to SUCCESS from latest attempt',
        context: {
          booking_id: event.booking_id,
          booking_event_id: event.id,
          side_effect_id: effect.id,
          side_effect_intent: effect.effect_intent,
          last_attempt_id: lastAttempt.id,
          last_attempt_num: lastAttempt.attempt_num,
          branch_taken: 'reconcile_processing_to_success_from_latest_attempt',
          deny_reason: 'side_effect_stuck_processing',
        },
      });
      continue;
    }

    const reconciledStatus = sideEffectStatusAfterAttempt('FAILED', lastAttempt.attempt_num, effect.max_attempts);
    await ctx.providers.repository.updateBookingSideEffect(effect.id, {
      status: reconciledStatus,
      expires_at: null,
      updated_at: new Date().toISOString(),
    });
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'side_effect_processing_reconciled',
      message: 'Reconciled stuck PROCESSING side effect from latest failed attempt',
      context: {
        booking_id: event.booking_id,
        booking_event_id: event.id,
        side_effect_id: effect.id,
        side_effect_intent: effect.effect_intent,
        last_attempt_id: lastAttempt.id,
        last_attempt_num: lastAttempt.attempt_num,
        reconciled_status: reconciledStatus,
        branch_taken: reconciledStatus === 'DEAD'
          ? 'reconcile_processing_to_dead_from_latest_failed_attempt'
          : 'reconcile_processing_to_failed_from_latest_failed_attempt',
        deny_reason: 'side_effect_stuck_processing',
      },
    });
  }
}
