alter table public.booking_side_effects
  drop constraint if exists booking_side_effects_effect_intent_check;

alter table public.booking_side_effects
  add constraint booking_side_effects_effect_intent_check
  check (
    effect_intent = any (
      array[
        'SEND_BOOKING_CONFIRMATION_REQUEST'::text,
        'SEND_BOOKING_CONFIRMATION'::text,
        'SEND_BOOKING_REFUND_CONFIRMATION'::text,
        'SEND_PAYMENT_LINK'::text,
        'SEND_PAYMENT_REMINDER'::text,
        'SEND_BOOKING_CANCELLATION_CONFIRMATION'::text,
        'SEND_BOOKING_EXPIRATION_NOTIFICATION'::text,
        'SEND_EVENT_REMINDER'::text,
        'CREATE_STRIPE_CHECKOUT'::text,
        'VERIFY_EMAIL_CONFIRMATION'::text,
        'VERIFY_STRIPE_PAYMENT'::text,
        'CREATE_STRIPE_REFUND'::text,
        'RESERVE_CALENDAR_SLOT'::text,
        'UPDATE_CALENDAR_SLOT'::text,
        'CANCEL_CALENDAR_SLOT'::text
      ]
    )
  );
