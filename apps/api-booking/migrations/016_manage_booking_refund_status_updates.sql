-- Align booking status/event/effect enums with manage-booking cancellation+refund policy.

alter table bookings
  drop constraint if exists bookings_current_status_check;

update bookings
set current_status = 'COMPLETED'
where current_status = 'CLOSED';

alter table bookings
  add constraint bookings_current_status_check
  check (current_status in ('PENDING_CONFIRMATION', 'SLOT_CONFIRMED', 'PAID', 'EXPIRED', 'CANCELED', 'COMPLETED', 'NO_SHOW', 'REFUNDED'));

alter table booking_events
  drop constraint if exists booking_events_event_type_check;

alter table booking_events
  add constraint booking_events_event_type_check
  check (
    event_type in (
      'BOOKING_FORM_SUBMITTED_FREE',
      'BOOKING_FORM_SUBMITTED_PAY_NOW',
      'BOOKING_FORM_SUBMITTED_PAY_LATER',
      'EMAIL_CONFIRMED',
      'BOOKING_RESCHEDULED',
      'SLOT_RESERVATION_REMINDER_SENT',
      'PAYMENT_REMINDER_SENT',
      'DATE_REMINDER_SENT',
      'BOOKING_EXPIRED',
      'BOOKING_CANCELED',
      'CASH_AUTHORIZED',
      'PAYMENT_SETTLED',
      'SLOT_CONFIRMED',
      'BOOKING_CLOSED',
      'REFUND_REQUESTED',
      'REFUND_CREATED',
      'REFUND_VERIFIED'
    )
  );

alter table booking_side_effects
  drop constraint if exists booking_side_effects_effect_intent_check;

alter table booking_side_effects
  add constraint booking_side_effects_effect_intent_check
  check (
    effect_intent in (
      'send_email_confirmation',
      'send_slot_reservation_reminder',
      'send_payment_reminder',
      'send_date_reminder',
      'send_booking_failed_notification',
      'send_booking_cancellation_confirmation',
      'send_booking_confirmation',
      'reserve_slot',
      'update_reserved_slot',
      'cancel_reserved_slot',
      'create_stripe_checkout',
      'verify_stripe_payment',
      'create_stripe_refund',
      'verify_stripe_refund',
      'send_payment_link',
      'expire_booking',
      'close_booking'
    )
  );
