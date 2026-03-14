import type {
  Booking,
  BookingCurrentStatus,
  BookingEffectIntent,
  BookingEventType,
  BookingSideEffectEntity,
  BookingType,
  NewBookingSideEffect,
  PaymentStatus,
} from '../types.js';
import type { BookingPolicyConfig } from '../config/booking-policy.js';
import {
  applyBookingPolicyOverridesForTests,
  getBookingPolicyConfig,
  getBookingPolicyText,
  resetBookingPolicyForTests,
} from '../config/booking-policy.js';
import { inferEntityFromIntent } from '../providers/repository/interface.js';
export type { BookingPolicyConfig } from '../config/booking-policy.js';
export { applyBookingPolicyOverridesForTests, getBookingPolicyConfig, getBookingPolicyText, resetBookingPolicyForTests } from '../config/booking-policy.js';

export interface BookingPolicyContext {
  booking: Pick<Booking, 'id' | 'event_id' | 'starts_at' | 'current_status' | 'booking_type'>;
  eventType: BookingEventType;
  eventAtIso: string;
  paymentStatus?: PaymentStatus | null;
}

export interface BookingEffectSpec {
  entity: BookingSideEffectEntity;
  effect_intent: BookingEffectIntent;
  expires_at: string | null;
  max_attempts: number;
}

export interface SlotReservationTransitionInput {
  booking: Pick<Booking, 'event_id' | 'booking_type'>;
  eventType: BookingEventType;
  previousStatus: BookingCurrentStatus;
  nextStatus: BookingCurrentStatus;
}

function isReservationEntitledStatus(status: BookingCurrentStatus): boolean {
  return status === 'CONFIRMED';
}

function isReservationFinalizationEvent(eventType: BookingEventType): boolean {
  return eventType === 'PAYMENT_SETTLED' || eventType === 'BOOKING_FORM_SUBMITTED';
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
  policy: BookingPolicyConfig,
): BookingEffectSpec[] {
  const previousStatus = input.booking.current_status;
  const nextStatus = currentStatusForEvent(
    input.eventType,
    previousStatus,
    input.booking.booking_type,
    input.paymentStatus ?? null,
  );
  const startsAtMs = new Date(input.booking.starts_at).getTime();
  const eventAtMs = new Date(input.eventAtIso).getTime();

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
    case 'BOOKING_FORM_SUBMITTED':
      switch (input.booking.booking_type) {
        case 'FREE':
          return [
            make('SEND_BOOKING_CONFIRMATION_REQUEST', null),
            make('VERIFY_EMAIL_CONFIRMATION', inMinutes(policy.nonPaidConfirmationWindowMinutes)),
          ];
        case 'PAY_LATER':
          return [
            make('SEND_BOOKING_CONFIRMATION_REQUEST', null),
            make('VERIFY_EMAIL_CONFIRMATION', inMinutes(policy.nonPaidConfirmationWindowMinutes)),
          ];
        case 'PAY_NOW':
          return [
            make('CREATE_STRIPE_CHECKOUT', null),
            make('VERIFY_STRIPE_PAYMENT', inMinutes(policy.payNowCheckoutWindowMinutes)),
          ];
      }
      return [];
    case 'BOOKING_RESCHEDULED':
      return [make('UPDATE_CALENDAR_SLOT', null)];
    case 'BOOKING_CANCELED': {
      const effects: BookingEffectSpec[] = [
        make('CANCEL_CALENDAR_SLOT', null),
        make('SEND_BOOKING_CANCELLATION_CONFIRMATION', null),
      ];
      if (input.paymentStatus === 'SUCCEEDED') {
        effects.push(make('CREATE_STRIPE_REFUND', null));
      }
      return effects;
    }
    case 'BOOKING_EXPIRED':
      return [
        make('CANCEL_CALENDAR_SLOT', null),
        make('SEND_BOOKING_EXPIRATION_NOTIFICATION', null),
      ];
    case 'PAYMENT_SETTLED':
      return [
        make('RESERVE_CALENDAR_SLOT', null),
        make('SEND_BOOKING_CONFIRMATION', null),
      ];
    case 'REFUND_COMPLETED':
      return [];
    default:
      return [];
  }
}

export function currentStatusForEvent(
  eventType: BookingEventType,
  previous: BookingCurrentStatus,
  bookingType: BookingType,
  paymentStatus?: PaymentStatus | null,
): BookingCurrentStatus {
  switch (eventType) {
    case 'BOOKING_FORM_SUBMITTED':
      return 'PENDING';
    case 'PAYMENT_SETTLED':
      return 'CONFIRMED';
    case 'BOOKING_EXPIRED':
      return 'EXPIRED';
    case 'BOOKING_CANCELED':
      return 'CANCELED';
    case 'BOOKING_RESCHEDULED':
    case 'REFUND_COMPLETED':
      if (paymentStatus === 'REFUNDED') return previous;
      return previous;
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
    status: 'PENDING',
    expires_at: effect.expires_at,
    max_attempts: effect.max_attempts,
  }));
}
