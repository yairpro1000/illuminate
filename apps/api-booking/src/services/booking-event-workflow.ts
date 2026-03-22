import { consumeLatestProviderApiLogId, extendOperationContext } from '../lib/execution.js';
import { syncApiLogOperationReferences } from '../lib/technical-observability.js';
import { resolveSideEffectAttemptOutcome } from '../domain/booking-effect-policy.js';
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
}

interface StartedAttempt {
  attempt: BookingSideEffectAttempt;
  attemptNum: number;
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
  const sideEffects = await ctx.providers.repository.listBookingSideEffectsForEvent(eventId);
  const nextStatus = deriveBookingEventStatus(sideEffects, options.startedExecution);
  const terminal = nextStatus === 'SUCCESS' || nextStatus === 'FAILED';
  return ctx.providers.repository.updateBookingEvent(eventId, {
    status: nextStatus,
    error_message: nextStatus === 'FAILED' ? options.failureMessage ?? event.error_message : null,
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

  if (input.sideEffects.length === 0) {
    const finalizedEvent = await finalizeBookingEventStatus(input.event.id, ctx);
    return {
      booking: currentBooking,
      event: finalizedEvent,
      sideEffects: input.sideEffects,
      effectResults,
    };
  }

  await ctx.providers.repository.updateBookingEvent(input.event.id, {
    status: 'PROCESSING',
    error_message: null,
    completed_at: null,
    updated_at: new Date().toISOString(),
  });

  for (const effect of input.sideEffects) {
    const result = await executeBookingSideEffectLifecycle(
      {
        booking: currentBooking,
        event: input.event,
        effect,
        sourceOperation: input.sourceOperation,
        triggerSource: input.triggerSource,
        executeEffect: input.executeEffect,
      },
      ctx,
    );
    currentBooking = result.booking;
    effectResults.push(result.effectResult);
  }

  const finalizedEvent = await finalizeBookingEventStatus(input.event.id, ctx, { startedExecution: true });
  const refreshedEffects = await ctx.providers.repository.listBookingSideEffectsForEvent(input.event.id);
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
    executeEffect: (input: BookingSideEffectExecutorInput) => Promise<BookingSideEffectExecutorResult>;
  },
  ctx: BookingContext,
): Promise<{ booking: Booking; effectResult: BookingEventEffectResult }> {
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
    const apiLogId = consumeLatestProviderApiLogId(ctx.operation);
    await finishBookingSideEffectAttempt(
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
      effectResult: {
        effectId: input.effect.id,
        effectIntent: input.effect.effect_intent,
        booking: executed.booking,
        metadata: executed.metadata ?? null,
        outcome: 'SUCCESS',
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error && error.message ? error.message : String(error);
    const apiLogId = consumeLatestProviderApiLogId(ctx.operation);
    await finishBookingSideEffectAttempt(
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
    status: 'PROCESSING',
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

  await ctx.providers.repository.updateBookingSideEffect(effect.id, {
    status: 'PROCESSING',
    updated_at: new Date().toISOString(),
  });

  return { attempt, attemptNum };
}

async function finishBookingSideEffectAttempt(
  input: {
    effect: BookingSideEffect;
    booking: Booking;
    attempt: StartedAttempt;
    status: 'SUCCESS' | 'FAILED';
    errorMessage: string | null;
    apiLogId: string | null;
    enableCalendarBackoff: boolean;
    logSource: 'backend' | 'cron' | 'worker';
  },
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
