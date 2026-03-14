import type { Logger } from './logger.js';

export type AppArea = 'website' | 'admin' | 'pa';

export interface OperationContext {
  appArea: AppArea;
  requestId: string;
  correlationId: string;
  bookingId: string | null;
  bookingEventId: string | null;
  sideEffectId: string | null;
  sideEffectAttemptId: string | null;
  latestProviderApiLogId: string | null;
  latestInboundErrorCode: string | null;
  latestInboundErrorMessage: string | null;
}

export function createOperationContext(input: {
  appArea: AppArea;
  requestId: string;
  correlationId: string;
}): OperationContext {
  return {
    appArea: input.appArea,
    requestId: input.requestId,
    correlationId: input.correlationId,
    bookingId: null,
    bookingEventId: null,
    sideEffectId: null,
    sideEffectAttemptId: null,
    latestProviderApiLogId: null,
    latestInboundErrorCode: null,
    latestInboundErrorMessage: null,
  };
}

export function extendOperationContext(
  base: OperationContext,
  overrides: Partial<OperationContext>,
): OperationContext {
  base.appArea = overrides.appArea ?? base.appArea;
  base.requestId = overrides.requestId ?? base.requestId;
  base.correlationId = overrides.correlationId ?? base.correlationId;
  base.bookingId = overrides.bookingId ?? base.bookingId;
  base.bookingEventId = overrides.bookingEventId ?? base.bookingEventId;
  base.sideEffectId = overrides.sideEffectId ?? base.sideEffectId;
  base.sideEffectAttemptId = overrides.sideEffectAttemptId ?? base.sideEffectAttemptId;
  base.latestProviderApiLogId = overrides.latestProviderApiLogId ?? base.latestProviderApiLogId;
  base.latestInboundErrorCode = overrides.latestInboundErrorCode ?? base.latestInboundErrorCode;
  base.latestInboundErrorMessage = overrides.latestInboundErrorMessage ?? base.latestInboundErrorMessage;
  return base;
}

export function operationReferenceFields(
  operation: Pick<OperationContext, 'bookingId' | 'bookingEventId' | 'sideEffectId' | 'sideEffectAttemptId'>,
): {
  booking_id: string | null;
  booking_event_id: string | null;
  side_effect_id: string | null;
  side_effect_attempt_id: string | null;
} {
  return {
    booking_id: operation.bookingId,
    booking_event_id: operation.bookingEventId,
    side_effect_id: operation.sideEffectId,
    side_effect_attempt_id: operation.sideEffectAttemptId,
  };
}

export function loggerForOperation(baseLogger: Logger, operation: OperationContext): Logger {
  if (typeof (baseLogger as { child?: unknown }).child !== 'function') {
    return baseLogger;
  }
  return baseLogger.child({
    requestId: operation.requestId,
    correlationId: operation.correlationId,
    context: {
      app_area: operation.appArea,
      ...operationReferenceFields(operation),
    },
  });
}

export function consumeLatestProviderApiLogId(operation?: OperationContext): string | null {
  if (!operation) return null;
  const value = operation.latestProviderApiLogId;
  operation.latestProviderApiLogId = null;
  return value;
}
