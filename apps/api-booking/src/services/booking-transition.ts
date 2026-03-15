import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import { extendOperationContext, type OperationContext } from '../lib/execution.js';
import type {
  Booking,
  BookingEventRecord,
  BookingEventSource,
  BookingEventType,
  BookingSideEffect,
} from '../types.js';
import { bookingEventLogContext, toEventPayload } from '../domain/booking-domain.js';
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
): Promise<TransitionResult> {
  const booking = await ctx.providers.repository.getBookingById(bookingId);
  if (!booking) {
    throw new Error(`Booking ${bookingId} not found while appending event ${eventType}`);
  }
  const policy = await getBookingPolicyConfig(ctx.providers.repository);

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_transition_start',
    message: 'Appending booking event and policy side effects',
    context: {
      ...bookingEventLogContext(bookingId, eventType, source, payload),
      branch_taken: 'append_event_then_generate_side_effects',
      current_status_before: booking.current_status,
      policy: {
        non_paid_confirmation_window_minutes: policy.nonPaidConfirmationWindowMinutes,
        pay_now_checkout_window_minutes: policy.payNowCheckoutWindowMinutes,
        pay_now_reminder_grace_minutes: policy.payNowReminderGraceMinutes,
        payment_due_before_start_hours: policy.paymentDueBeforeStartHours,
        processing_max_attempts: policy.processingMaxAttempts,
      },
    },
  });
  ctx.logger.info?.('booking transition start', { bookingId, eventType, source });

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

  const payment = await ctx.providers.repository.getPaymentByBookingId(bookingId);

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

  const nextStatus = currentStatusForEvent(
    eventType,
    booking.current_status,
    booking.booking_type,
    payment?.status ?? null,
  );
  const updatedBooking = nextStatus === booking.current_status
    ? booking
    : await ctx.providers.repository.updateBooking(bookingId, { current_status: nextStatus });

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_transition_complete',
    message: 'Booking event persisted and policy side effects generated',
    context: {
      ...bookingEventLogContext(bookingId, eventType, source, normalizedPayload),
      booking_type: booking.booking_type,
      payment_status: payment?.status ?? null,
      current_status_before: booking.current_status,
      current_status_after: updatedBooking.current_status,
      side_effect_count: sideEffects.length,
      side_effect_intents: sideEffects.map((sideEffect) => sideEffect.effect_intent),
      branch_taken: sideEffects.length > 0 ? 'event_and_side_effects_created' : 'event_created_no_side_effects',
    },
  });
  ctx.logger.info?.('booking transition complete', { bookingId, eventType, source, sideEffectCount: sideEffects.length });

  return {
    booking: updatedBooking,
    event,
    sideEffects,
  };
}
