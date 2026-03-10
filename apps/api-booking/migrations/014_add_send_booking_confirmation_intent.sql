-- Adds explicit side-effect intent for post-payment booking confirmation emails.

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
      'send_payment_link',
      'expire_booking',
      'close_booking'
    )
  );
