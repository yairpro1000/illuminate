import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type {
  Booking,
  BookingEventRecord,
  BookingEventSource,
  BookingEventType,
  BookingSideEffect,
} from '../types.js';
import { bookingEventLogContext, toEventPayload } from '../domain/booking-domain.js';
import {
  DEFAULT_BOOKING_POLICY,
  currentStatusForEvent,
  getEffectsForEvent,
  mapEffectsToRows,
} from '../domain/booking-effect-policy.js';

export interface TransitionContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
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

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_transition_start',
    message: 'Appending booking event and policy side effects',
    context: {
      ...bookingEventLogContext(bookingId, eventType, source, payload),
      branch_taken: 'append_event_then_generate_side_effects',
      current_status_before: booking.current_status,
      policy: {
        non_paid_confirmation_window_minutes: DEFAULT_BOOKING_POLICY.nonPaidConfirmationWindowMinutes,
        pay_now_checkout_window_minutes: DEFAULT_BOOKING_POLICY.payNowCheckoutWindowMinutes,
        pay_now_reminder_grace_minutes: DEFAULT_BOOKING_POLICY.payNowReminderGraceMinutes,
        payment_due_before_start_hours: DEFAULT_BOOKING_POLICY.paymentDueBeforeStartHours,
        processing_max_attempts: DEFAULT_BOOKING_POLICY.processingMaxAttempts,
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

  const paymentMode = await inferPaymentMode(bookingId, ctx);

  const effectSpecs = getEffectsForEvent({
    booking,
    eventType,
    eventAtIso: event.created_at,
    paymentMode,
  });

  const sideEffects = effectSpecs.length > 0
    ? await ctx.providers.repository.createBookingSideEffects(mapEffectsToRows(event.id, effectSpecs))
    : [];

  const nextStatus = currentStatusForEvent(eventType, booking.current_status, paymentMode);
  const updatedBooking = nextStatus === booking.current_status
    ? booking
    : await ctx.providers.repository.updateBooking(bookingId, { current_status: nextStatus });

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'booking_transition_complete',
    message: 'Booking event persisted and policy side effects generated',
    context: {
      ...bookingEventLogContext(bookingId, eventType, source, normalizedPayload),
      payment_mode: paymentMode,
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

async function inferPaymentMode(
  bookingId: string,
  ctx: TransitionContext,
): Promise<'free' | 'pay_now' | 'pay_later' | null> {
  const events = await ctx.providers.repository.listBookingEvents(bookingId);
  const submitted = [...events]
    .reverse()
    .find((event) =>
      event.event_type === 'BOOKING_FORM_SUBMITTED_FREE' ||
      event.event_type === 'BOOKING_FORM_SUBMITTED_PAY_NOW' ||
      event.event_type === 'BOOKING_FORM_SUBMITTED_PAY_LATER',
    );

  if (!submitted) return null;
  if (submitted.event_type === 'BOOKING_FORM_SUBMITTED_FREE') return 'free';
  if (submitted.event_type === 'BOOKING_FORM_SUBMITTED_PAY_NOW') return 'pay_now';
  return 'pay_later';
}
