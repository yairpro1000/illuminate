# Booking State Model

The booking lifecycle is event-driven.

- Canonical truth: `booking_events`
- Cached read status: `bookings.current_status`
- Intended reactions: `booking_side_effects`
- Execution/retry history: `booking_side_effect_attempts`

## Current Status Cache

`bookings.current_status` values:

```text
PENDING_CONFIRMATION
SLOT_CONFIRMED
PAID
EXPIRED
CANCELED
CLOSED
```

This cache is synchronized from incoming business events. It is not the source of truth.

## Business Events

`booking_events.event_type` values:

```text
BOOKING_FORM_SUBMITTED_FREE
BOOKING_FORM_SUBMITTED_PAY_NOW
BOOKING_FORM_SUBMITTED_PAY_LATER
EMAIL_CONFIRMED
BOOKING_RESCHEDULED
SLOT_RESERVATION_REMINDER_SENT
PAYMENT_REMINDER_SENT
DATE_REMINDER_SENT
BOOKING_EXPIRED
BOOKING_CANCELED
CASH_AUTHORIZED
PAYMENT_SETTLED
SLOT_CONFIRMED
BOOKING_CLOSED
```

`booking_events.source` values:

```text
public_ui
admin_ui
job
webhook
system
```

## Side-Effect Policy

The event-to-effect mapping is centralized in `booking-effect-policy.ts`.

Key effect intents:

```text
send_email_confirmation
send_slot_reservation_reminder
send_payment_reminder
send_date_reminder
send_booking_failed_notification
send_booking_cancellation_confirmation
reserve_slot
update_reserved_slot
cancel_reserved_slot
confirm_reserved_slot
create_stripe_checkout
verify_stripe_payment
send_payment_link
expire_booking
close_booking
```

`booking_side_effects.status`:

```text
pending
processing
success
failed
dead
```

`booking_side_effect_attempts.status`:

```text
success
fail
```

## Deadline Policy

Configured in code and persisted per effect:

- non-paid confirmation: `15 minutes`
- pay-now checkout completion: `45 minutes`
- payment due threshold: `starts_at - 24 hours`

The calculated deadline is stored as `booking_side_effects.expires_at`.
