import { consumeLatestProviderApiLogId, extendOperationContext } from '../lib/execution.js';
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
  nextSideEffects?: BookingSideEffectQueueEntry[];
  handledFailure?: {
    errorMessage: string;
    enableCalendarBackoff?: boolean;
  } | null;
}

export interface BookingSideEffectQueueEntry {
  effect: BookingSideEffect;
  event?: BookingEventRecord;
  isFresh?: boolean;
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

interface AttemptFinishResult {
  effect: BookingSideEffect;
}

export async function finalizeBookingEventStatus(
  eventId: string,
  ctx: BookingContext,
  options: {
    startedExecution?: boolean;
    failureMessage?: string | null;
    reconcileProcessing?: boolean;
  } = {},
): Promise<BookingEventRecord> {
  const event = await ctx.providers.repository.getBookingEventById(eventId);
  if (!event) throw new Error(`booking_event_not_found:${eventId}`);
  if (options.reconcileProcessing) {
    await reconcileStuckProcessingSideEffects(event, ctx);
  }
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
    sideEffects: BookingSideEffectQueueEntry[];
    sourceOperation: string;
    triggerSource: 'realtime' | 'cron';
    executeEffect: (input: BookingSideEffectExecutorInput) => Promise<BookingSideEffectExecutorResult>;
  },
  ctx: BookingContext,
): Promise<BookingEventExecutionResult> {
  let currentBooking = input.booking;
  const effectResults: BookingEventEffectResult[] = [];
  const pendingEffects = [...input.sideEffects];
  const queuedEffectIds = new Set(input.sideEffects.map((entry) => entry.effect.id));
  const eventsById = new Map<string, BookingEventRecord>([[input.event.id, input.event]]);
  const sideEffectsByEventId = new Map<string, BookingSideEffect[]>();
  const startedEventIds = new Set<string>();
  sideEffectsByEventId.set(input.event.id, input.sideEffects.map((entry) => entry.effect));

  if (pendingEffects.length === 0) {
    const finalizedEvent = await finalizeBookingEventStatus(input.event.id, ctx);
    return {
      booking: currentBooking,
      event: finalizedEvent,
      sideEffects: input.sideEffects.map((entry) => entry.effect),
      effectResults,
    };
  }

  async function resolveEventForEffect(entry: BookingSideEffectQueueEntry): Promise<BookingEventRecord> {
    if (entry.event) {
      eventsById.set(entry.event.id, entry.event);
      return entry.event;
    }
    const cached = eventsById.get(entry.effect.booking_event_id);
    if (cached) return cached;
    const event = await ctx.providers.repository.getBookingEventById(entry.effect.booking_event_id);
    if (!event) throw new Error(`booking_event_not_found:${entry.effect.booking_event_id}`);
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

  function rememberSideEffect(effect: BookingSideEffect): void {
    const existing = sideEffectsByEventId.get(effect.booking_event_id) ?? [];
    const index = existing.findIndex((candidate) => candidate.id === effect.id);
    if (index >= 0) {
      existing[index] = effect;
    } else {
      existing.push(effect);
    }
    sideEffectsByEventId.set(effect.booking_event_id, existing);
  }

  while (pendingEffects.length > 0) {
    const queueEntry = pendingEffects.shift();
    if (!queueEntry) break;
    const effect = queueEntry.effect;
    const effectEvent = await resolveEventForEffect(queueEntry);
    await markEventExecutionStarted(effectEvent.id);
    const result = await executeBookingSideEffectLifecycle(
      {
        booking: currentBooking,
        event: effectEvent,
        effect,
        sourceOperation: input.sourceOperation,
        triggerSource: input.triggerSource,
        isFreshEffect: Boolean(queueEntry.isFresh),
        executeEffect: input.executeEffect,
      },
      ctx,
    );
    currentBooking = result.booking;
    effectResults.push(result.effectResult);
    rememberSideEffect(result.effect);
    for (const nextEntry of result.nextSideEffects) {
      if (queuedEffectIds.has(nextEntry.effect.id)) continue;
      queuedEffectIds.add(nextEntry.effect.id);
      pendingEffects.push(nextEntry);
      rememberSideEffect(nextEntry.effect);
    }
  }

  const finalEvents = new Map<string, BookingEventRecord>();
  for (const eventId of startedEventIds) {
    const finalized = await updateBookingEventFromKnownSideEffects(
      eventId,
      sideEffectsByEventId.get(eventId) ?? [],
      ctx,
      { startedExecution: true },
    );
    finalEvents.set(eventId, finalized);
  }
  const finalizedEvent = finalEvents.get(input.event.id)
    ?? await updateBookingEventFromKnownSideEffects(
      input.event.id,
      sideEffectsByEventId.get(input.event.id) ?? input.sideEffects.map((entry) => entry.effect),
      ctx,
      { startedExecution: true },
    );
  const refreshedEffects = sideEffectsByEventId.get(input.event.id) ?? input.sideEffects.map((entry) => entry.effect);
  return {
    booking: currentBooking,
    event: finalizedEvent,
    sideEffects: refreshedEffects,
    effectResults,
  };
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
    isFreshEffect: boolean;
    executeEffect: (input: BookingSideEffectExecutorInput) => Promise<BookingSideEffectExecutorResult>;
  },
  ctx: BookingContext,
): Promise<{ booking: Booking; effect: BookingSideEffect; effectResult: BookingEventEffectResult; nextSideEffects: BookingSideEffectQueueEntry[] }> {
  const startedAttempt = await startBookingSideEffectAttempt(
    input.effect,
    input.booking,
    input.event,
    ctx,
    { isFresh: input.isFreshEffect },
  );
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
      const finalizedEffect = await completeAttemptWithGuaranteedPersistence(
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
        effect: finalizedEffect,
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
    const finalizedEffect = await completeAttemptWithGuaranteedPersistence(
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
    return {
      booking: executed.booking,
      effect: finalizedEffect,
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
  options: { isFresh?: boolean } = {},
): Promise<StartedAttempt> {
  const lastAttempt = options.isFresh
    ? null
    : await ctx.providers.repository.getLastBookingSideEffectAttempt(effect.id);
  const attemptNum = options.isFresh ? 1 : (lastAttempt?.attempt_num ?? 0) + 1;
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
): Promise<AttemptFinishResult> {
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
  const effect = await ctx.providers.repository.updateBookingSideEffect(input.effect.id, {
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
  return { effect };
}

async function completeAttemptWithGuaranteedPersistence(
  input: AttemptFinishInput,
  ctx: BookingContext,
): Promise<BookingSideEffect> {
  try {
    const finalized = await finishBookingSideEffectAttempt(input, ctx);
    return finalized.effect;
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

async function updateBookingEventFromKnownSideEffects(
  eventId: string,
  sideEffects: BookingSideEffect[],
  ctx: BookingContext,
  options: {
    startedExecution?: boolean;
    failureMessage?: string | null;
  } = {},
): Promise<BookingEventRecord> {
  const event = await ctx.providers.repository.getBookingEventById(eventId);
  if (!event) throw new Error(`booking_event_not_found:${eventId}`);
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
