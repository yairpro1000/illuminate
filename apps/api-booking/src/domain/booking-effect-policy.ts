import type {
  Booking,
  BookingCurrentStatus,
  BookingEffectIntent,
  BookingEventType,
  BookingSideEffectEntity,
  NewBookingSideEffect,
} from '../types.js';
import { inferEntityFromIntent } from '../providers/repository/interface.js';

export interface BookingPolicyConfig {
  nonPaidConfirmationWindowMinutes: number;
  payNowCheckoutWindowMinutes: number;
  payNowReminderGraceMinutes: number;
  paymentDueBeforeStartHours: number;
  processingMaxAttempts: number;
}

export const DEFAULT_BOOKING_POLICY: BookingPolicyConfig = {
  nonPaidConfirmationWindowMinutes: 1,
  payNowCheckoutWindowMinutes: 2,
  payNowReminderGraceMinutes: 1,
  paymentDueBeforeStartHours: 24,
  processingMaxAttempts: 5,
};

export interface BookingPolicyContext {
  booking: Pick<Booking, 'id' | 'event_id' | 'starts_at' | 'current_status'>;
  eventType: BookingEventType;
  eventAtIso: string;
  paymentMode?: 'free' | 'pay_now' | 'pay_later' | null;
}

export interface BookingEffectSpec {
  entity: BookingSideEffectEntity;
  effect_intent: BookingEffectIntent;
  expires_at: string | null;
  max_attempts: number;
}

export interface SlotReservationTransitionInput {
  booking: Pick<Booking, 'event_id'>;
  eventType: BookingEventType;
  previousStatus: BookingCurrentStatus;
  nextStatus: BookingCurrentStatus;
}

function isReservationEntitledStatus(status: BookingCurrentStatus): boolean {
  return status === 'SLOT_CONFIRMED' || status === 'PAID';
}

function isReservationFinalizationEvent(eventType: BookingEventType): boolean {
  return eventType === 'EMAIL_CONFIRMED' || eventType === 'PAYMENT_SETTLED';
}

export function shouldReserveSlotForTransition(input: SlotReservationTransitionInput): boolean {
  if (input.booking.event_id) return false;
  if (!isReservationFinalizationEvent(input.eventType)) return false;
  if (!isReservationEntitledStatus(input.nextStatus)) return false;
  if (isReservationEntitledStatus(input.previousStatus)) return false;
  return true;
}

export function getEffectsForEvent(
  input: BookingPolicyContext,
  policy: BookingPolicyConfig = DEFAULT_BOOKING_POLICY,
): BookingEffectSpec[] {
  const paymentMode = input.paymentMode ?? null;
  const previousStatus = input.booking.current_status;
  const nextStatus = currentStatusForEvent(input.eventType, previousStatus, paymentMode);
  const startsAtMs = new Date(input.booking.starts_at).getTime();
  const eventAtMs = new Date(input.eventAtIso).getTime();
  const nowMs = Date.now();

  const inMinutes = (minutes: number): string => new Date(eventAtMs + minutes * 60_000).toISOString();
  const paymentDueThresholdIso = new Date(
    startsAtMs - policy.paymentDueBeforeStartHours * 60 * 60_000,
  ).toISOString();

  const make = (intent: BookingEffectIntent, expiresAt: string | null): BookingEffectSpec => ({
    entity: inferEntityFromIntent(intent),
    effect_intent: intent,
    expires_at: expiresAt,
    max_attempts: policy.processingMaxAttempts,
  });

  switch (input.eventType) {
    case 'BOOKING_FORM_SUBMITTED_FREE': {
      const windowIso = inMinutes(policy.nonPaidConfirmationWindowMinutes);
      return [
        make('send_email_confirmation', windowIso),
        make('expire_booking', windowIso),
      ];
    }
    case 'BOOKING_FORM_SUBMITTED_PAY_NOW': {
      const reminderIso = inMinutes(policy.payNowCheckoutWindowMinutes);
      const expiryIso = inMinutes(policy.payNowCheckoutWindowMinutes + policy.payNowReminderGraceMinutes);
      return [
        // Checkout is created synchronously in submit flow; keep this as audit intent only.
        make('create_stripe_checkout', null),
        make('send_payment_link', reminderIso),
        make('expire_booking', expiryIso),
      ];
    }
    case 'BOOKING_FORM_SUBMITTED_PAY_LATER': {
      const windowIso = inMinutes(policy.nonPaidConfirmationWindowMinutes);
      return [
        make('send_email_confirmation', windowIso),
        make('expire_booking', windowIso),
      ];
    }
    case 'EMAIL_CONFIRMED':
      if (shouldReserveSlotForTransition({
        booking: input.booking,
        eventType: input.eventType,
        previousStatus,
        nextStatus,
      })) {
        return [make('reserve_slot', null)];
      }
      if (input.booking.event_id) {
        return [make('send_booking_confirmation', null)];
      }
      return [];
    case 'BOOKING_RESCHEDULED':
      return [make('update_reserved_slot', null)];
    case 'BOOKING_EXPIRED':
      return [
        make('cancel_reserved_slot', null),
        make('send_booking_failed_notification', null),
      ];
    case 'BOOKING_CANCELED':
      return [
        make('cancel_reserved_slot', null),
        make('send_booking_cancellation_confirmation', null),
      ];
    case 'REFUND_REQUESTED':
      return [make('create_stripe_refund', null)];
    case 'REFUND_CREATED':
      return [make('verify_stripe_refund', null)];
    case 'PAYMENT_SETTLED':
      return shouldReserveSlotForTransition({
        booking: input.booking,
        eventType: input.eventType,
        previousStatus,
        nextStatus,
      })
        ? [make('reserve_slot', null)]
        : [];
    case 'SLOT_CONFIRMED': {
      const effects: BookingEffectSpec[] = [];
      const dateReminderEligible = startsAtMs > nowMs && !['CANCELED', 'EXPIRED'].includes(input.booking.current_status);
      if (dateReminderEligible) {
        effects.push(make('send_date_reminder', new Date(startsAtMs).toISOString()));
      }
      if (paymentMode === 'free' || paymentMode === 'pay_now' || paymentMode === 'pay_later') {
        effects.push(make('send_booking_confirmation', null));
      }
      if (paymentMode === 'pay_later') {
        effects.push(make('send_payment_reminder', paymentDueThresholdIso));
      }
      return effects;
    }
    case 'BOOKING_CLOSED':
      return [make('close_booking', null)];
    case 'REFUND_VERIFIED':
      return [];
    case 'SLOT_RESERVATION_REMINDER_SENT':
    case 'PAYMENT_REMINDER_SENT':
    case 'DATE_REMINDER_SENT':
    case 'CASH_AUTHORIZED':
      return [];
    default:
      return [];
  }
}

export function currentStatusForEvent(
  eventType: BookingEventType,
  previous: BookingCurrentStatus,
  _paymentMode?: 'free' | 'pay_now' | 'pay_later' | null,
): BookingCurrentStatus {
  switch (eventType) {
    case 'BOOKING_FORM_SUBMITTED_FREE':
    case 'BOOKING_FORM_SUBMITTED_PAY_NOW':
    case 'BOOKING_FORM_SUBMITTED_PAY_LATER':
      return 'PENDING_CONFIRMATION';
    case 'EMAIL_CONFIRMED':
      return 'SLOT_CONFIRMED';
    case 'PAYMENT_SETTLED':
      return 'PAID';
    case 'SLOT_CONFIRMED':
      return previous === 'PAID' ? 'PAID' : 'SLOT_CONFIRMED';
    case 'BOOKING_EXPIRED':
      return 'EXPIRED';
    case 'BOOKING_CANCELED':
      return 'CANCELED';
    case 'BOOKING_CLOSED':
      return 'COMPLETED';
    case 'REFUND_VERIFIED':
      return 'REFUNDED';
    default:
      return previous;
  }
}

export function mapEffectsToRows(
  bookingEventId: string,
  effects: BookingEffectSpec[],
): NewBookingSideEffect[] {
  return effects.map((effect) => ({
    booking_event_id: bookingEventId,
    entity: effect.entity,
    effect_intent: effect.effect_intent,
    status: 'pending',
    expires_at: effect.expires_at,
    max_attempts: effect.max_attempts,
  }));
}
