import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import { extendOperationContext, type OperationContext } from '../lib/execution.js';
import { syncApiLogOperationReferences } from '../lib/technical-observability.js';
import {
  resolveSideEffectAttemptOutcome,
  type SideEffectAttemptOutcome,
} from '../domain/booking-effect-policy.js';
import type { BookingEffectIntent, BookingSideEffect } from '../types.js';

interface SideEffectAttemptRecordingContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
  operation?: OperationContext;
}

export interface RecordedSideEffectAttempt extends SideEffectAttemptOutcome {
  effectId: string;
  attemptNum: number;
}

export async function recordSideEffectAttempts(
  effects: Array<Pick<BookingSideEffect, 'id' | 'effect_intent' | 'max_attempts'>>,
  input: {
    status: 'SUCCESS' | 'FAILED';
    errorMessage: string | null;
    apiLogId: string | null;
    ctx: SideEffectAttemptRecordingContext;
    bookingId?: string | null;
    logSource?: 'backend' | 'cron' | 'worker';
    enableCalendarBackoff?: boolean;
  },
): Promise<RecordedSideEffectAttempt[]> {
  const outcomes: RecordedSideEffectAttempt[] = [];

  for (const effect of effects) {
    const lastAttempt = await input.ctx.providers.repository.getLastBookingSideEffectAttempt(effect.id);
    const attemptNum = (lastAttempt?.attempt_num ?? 0) + 1;
    const createdAttempt = await input.ctx.providers.repository.createBookingSideEffectAttempt({
      booking_side_effect_id: effect.id,
      attempt_num: attemptNum,
      api_log_id: input.apiLogId,
      status: input.status,
      error_message: input.errorMessage,
      completed_at: new Date().toISOString(),
    });

    if (input.ctx.operation) {
      extendOperationContext(input.ctx.operation, {
        sideEffectId: effect.id,
        sideEffectAttemptId: createdAttempt.id,
      });
    }
    await syncApiLogOperationReferences(input.ctx.env, input.apiLogId, input.ctx.operation);

    const outcome = resolveSideEffectAttemptOutcome(
      {
        effectIntent: effect.effect_intent,
        maxAttempts: effect.max_attempts,
      },
      {
        attemptStatus: input.status,
        attemptNum,
        enableCalendarBackoff: input.enableCalendarBackoff ?? false,
      },
    );

    await input.ctx.providers.repository.updateBookingSideEffect(effect.id, {
      status: outcome.nextStatus,
      expires_at: outcome.expiresAt,
      updated_at: new Date().toISOString(),
    });

    if (outcome.retryDelayMs !== null) {
      logCalendarRetry(
        effect.effect_intent,
        {
          bookingId: input.bookingId ?? input.ctx.operation?.bookingId ?? null,
          requestId: input.ctx.requestId,
          attemptNum,
          delayMs: outcome.retryDelayMs,
          reason: input.errorMessage,
          source: input.logSource ?? 'backend',
          logger: input.ctx.logger,
        },
      );
    }

    outcomes.push({
      effectId: effect.id,
      attemptNum,
      ...outcome,
    });
  }

  return outcomes;
}

function logCalendarRetry(
  effectIntent: BookingEffectIntent,
  input: {
    bookingId: string | null;
    requestId: string;
    attemptNum: number;
    delayMs: number;
    reason: string | null;
    source: 'backend' | 'cron' | 'worker';
    logger: Logger;
  },
): void {
  input.logger.logWarn?.({
    source: input.source,
    eventType: 'calendar_retry',
    message: 'Scheduled retry for calendar side effect after retryable provider failure',
    context: {
      booking_id: input.bookingId,
      effect_intent: effectIntent,
      attempt: input.attemptNum,
      delay_ms: input.delayMs,
      reason: input.reason ?? 'calendar_sync_failed',
      request_id: input.requestId,
      branch_taken: 'schedule_retryable_calendar_side_effect_with_backoff',
      deny_reason: null,
    },
  });
}
