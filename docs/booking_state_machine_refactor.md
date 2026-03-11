# Booking Domain Refactor (Final Model)

Date: 2026-03-10

## Scope

This is a fresh-model cleanup of booking lifecycle persistence:

1. `bookings` keeps only stable facts + `current_status` cache.
2. `booking_events` is the canonical business timeline.
3. `booking_side_effects` stores intended reactions to events.
4. `booking_side_effect_attempts` stores execution and retries.

No legacy dual-state columns are kept on `bookings`.

## Final Domain Architecture

```text
bookings
  -> booking_events
      -> booking_side_effects
          -> booking_side_effect_attempts
```

## Canonical Enums (Text + Check Constraints)

`bookings.current_status`:

```text
PENDING_CONFIRMATION
SLOT_CONFIRMED
PAID
EXPIRED
CANCELED
CLOSED
```

`booking_events.source`:

```text
public_ui
admin_ui
job
webhook
system
```

`booking_side_effects.entity`:

```text
email
calendar
payment
system
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

## Event -> Effect Policy

Policy is centralized in `apps/api-booking/src/domain/booking-effect-policy.ts`.

Core timing rules:

- non-paid confirmation window: `15 min`
- pay-now checkout completion window: `45 min`
- payment due threshold: `booking.starts_at - 24h`

The policy computes `expires_at` for each side effect. The concrete deadline is persisted on `booking_side_effects.expires_at`.

## Notes

- `bookings.current_status` is convenience cache only.
- Business truth is reconstructable from `booking_events`.
- Side-effect retries append rows in `booking_side_effect_attempts` with incrementing `attempt_num`.
- Migration chain is reset to create-only schema (no ALTER/backfill workflow for booking tables).
