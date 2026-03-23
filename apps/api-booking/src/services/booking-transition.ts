import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import { extendOperationContext, type OperationContext } from '../lib/execution.js';
import type {
  Booking,
  BookingEventRecord,
  BookingEventSource,
  BookingEventType,
  Payment,
  BookingSideEffect,
} from '../types.js';
import { toEventPayload } from '../domain/booking-domain.js';
import {
  currentStatusForEvent,
  getEffectsForEvent,
  getBookingPolicyConfig,
  mapEffectsToRows,
} from '../domain/booking-effect-policy.js';

export interface TransitionContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
  correlationId?: string;
  operation?: OperationContext;
}

export interface TransitionResult {
  booking: Booking;
  event: BookingEventRecord;
  sideEffects: BookingSideEffect[];
}

export async function appendBookingEventWithEffects(
  bookingId: string,
  eventType: BookingEventType,
  source: BookingEventSource,
  payload: Record<string, unknown> | undefined,
  ctx: TransitionContext,
  state: {
    booking?: Booking;
    payment?: Pick<Payment, 'status'> | null;
    policy?: Awaited<ReturnType<typeof getBookingPolicyConfig>>;
  } = {},
): Promise<TransitionResult> {
  const booking = state.booking ?? await ctx.providers.repository.getBookingById(bookingId);
  if (!booking) {
    throw new Error(`Booking ${bookingId} not found while appending event ${eventType}`);
  }
  const policy = state.policy ?? await getBookingPolicyConfig(ctx.providers.repository);

  const normalizedPayload = toEventPayload(payload);
  const event = await ctx.providers.repository.createBookingEvent({
    booking_id: bookingId,
    event_type: eventType,
    source,
    payload: normalizedPayload,
  });
  if (ctx.operation) {
    extendOperationContext(ctx.operation, {
      bookingId,
      bookingEventId: event.id,
      sideEffectAttemptId: null,
    });
  }

  const payment = state.payment !== undefined
    ? state.payment
    : await ctx.providers.repository.getPaymentByBookingId(bookingId);

  const effectSpecs = getEffectsForEvent({
    booking,
    eventType,
    eventSource: source,
    eventAtIso: event.created_at,
    paymentStatus: payment?.status ?? null,
    eventPayload: normalizedPayload,
  }, policy);

  const sideEffects = effectSpecs.length > 0
    ? await ctx.providers.repository.createBookingSideEffects(mapEffectsToRows(event.id, effectSpecs))
    : [];

  const finalizedEvent = sideEffects.length > 0
    ? event
    : await ctx.providers.repository.updateBookingEvent(event.id, {
      status: 'SUCCESS',
      error_message: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

  const nextStatus = currentStatusForEvent(
    eventType,
    booking.current_status,
    booking.booking_type,
    payment?.status ?? null,
  );
  const updatedBooking = nextStatus === booking.current_status
    ? booking
    : await ctx.providers.repository.updateBooking(bookingId, { current_status: nextStatus });

  return {
    booking: updatedBooking,
    event: finalizedEvent,
    sideEffects,
  };
}
