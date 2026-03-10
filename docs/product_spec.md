# Product Specification

## Overview

Platform supports:

- 1:1 bookings
- free and paid event bookings
- event-driven booking lifecycle
- side-effect outbox with retry history
- calendar and payment provider integrations

## Booking Domain Contract

Persistence model:

```text
bookings                      -> stable facts + current_status cache
booking_events               -> canonical business timeline
booking_side_effects         -> intended reactions
booking_side_effect_attempts -> execution/retry history
```

`bookings.current_status` values:

```text
PENDING_CONFIRMATION
SLOT_CONFIRMED
PAID
EXPIRED
CANCELED
CLOSED
```

## Core Flows

### 1:1 Pay-Now (paid session)

1. Create booking (`PENDING_CONFIRMATION`).
2. Emit `BOOKING_FORM_SUBMITTED_PAY_NOW`.
3. Create side effects: `create_stripe_checkout`, `expire_booking`.
4. On settlement (`PAYMENT_SETTLED`), status advances to `PAID`.
5. Transition policy creates `reserve_slot`, executes it immediately, and appends `SLOT_CONFIRMED` on success.

### 1:1 Pay-Later

1. Create booking (`PENDING_CONFIRMATION`).
2. Emit `BOOKING_FORM_SUBMITTED_PAY_LATER`.
3. Create side effects: `send_email_confirmation`, `expire_booking`.
4. On `EMAIL_CONFIRMED`, transition policy creates `reserve_slot` and executes it immediately.
5. On successful reservation, append `SLOT_CONFIRMED`.
6. Payment reminder scheduling follows policy (`starts_at - 24h` threshold).

### 1:1 Free (intro)

1. Create booking (`PENDING_CONFIRMATION`).
2. Emit `BOOKING_FORM_SUBMITTED_FREE`.
3. Create side effects: `send_email_confirmation`, `expire_booking`.
4. On `EMAIL_CONFIRMED`, transition policy creates `reserve_slot` and executes it immediately.
5. On successful reservation, status remains `SLOT_CONFIRMED` and `SLOT_CONFIRMED` event is appended.

### Event Booking

- Uses the same booking/event/side-effect model.
- Paid events follow pay-now checkout flow.
- Free events follow confirmation flow.
- Late-access links remain event-scoped.

## Deadline Policy

Centralized in `booking-effect-policy.ts`:

- confirm non-paid email window: `15 min`
- pay-now checkout completion window: `45 min`
- payment due threshold: `booking.starts_at - 24h`

Resolved deadlines are persisted on `booking_side_effects.expires_at`.

## Invariants

- Exactly one of `bookings.event_id` or `bookings.session_type_id` is set.
- Business truth is reconstructable from `booking_events`.
- Side effects are retryable; each attempt is recorded with `attempt_num`.
- Calendar reservation is triggered by finalized transitions (`EMAIL_CONFIRMED`, `PAYMENT_SETTLED`) rather than submit actions.
- Old duplicated workflow columns are not part of the model.
