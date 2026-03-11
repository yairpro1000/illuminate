# Site Database Schema

This document describes the booking domain schema after the fresh-model reset.

## Booking Architecture

`bookings`
- Stable booking facts only.
- Includes a thin `current_status` cache for admin/query convenience.
- Does not store workflow duplication (no hold/payment/reminder/token workflow columns).

`booking_events`
- Canonical business timeline and source of truth.
- Every meaningful business transition is an event row.

`booking_side_effects`
- Intended system reactions generated from a booking event.
- One row per intended reaction.

`booking_side_effect_attempts`
- Concrete execution history for side effects.
- One-or-more rows per side effect (retry trail).

## Canonical Values

`booking_events.event_type` (ALL CAPS):

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

`booking_side_effects.effect_intent`:

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

`bookings.current_status` (cache):

```text
PENDING_CONFIRMATION
SLOT_CONFIRMED
PAID
EXPIRED
CANCELED
CLOSED
```

## Booking Domain DDL

The booking domain schema is defined in `apps/api-booking/migrations/010_booking_centric_schema.sql` and is create-only for reset environments.

```sql
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete restrict,
  event_id uuid null references events(id) on delete restrict,
  session_type_id uuid null references session_types(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Europe/Zurich',
  google_event_id text null,
  address_line text not null,
  maps_url text not null,
  current_status text not null check (
    current_status in ('PENDING_CONFIRMATION', 'SLOT_CONFIRMED', 'PAID', 'EXPIRED', 'CANCELED', 'CLOSED')
  ),
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_time_order check (ends_at > starts_at),
  constraint bookings_exactly_one_kind check (
    ((event_id is not null)::int + (session_type_id is not null)::int) = 1
  )
);

create table if not exists booking_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  event_type text not null,
  source text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists booking_side_effects (
  id uuid primary key default gen_random_uuid(),
  booking_event_id uuid not null references booking_events(id) on delete cascade,
  entity text not null,
  effect_intent text not null,
  status text not null,
  expires_at timestamptz null,
  max_attempts integer not null default 5 check (max_attempts >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists booking_side_effect_attempts (
  id uuid primary key default gen_random_uuid(),
  booking_side_effect_id uuid not null references booking_side_effects(id) on delete cascade,
  attempt_num integer not null check (attempt_num >= 1),
  api_log_id text null,
  status text not null check (status in ('success', 'fail')),
  error_message text null,
  created_at timestamptz not null default now(),
  unique (booking_side_effect_id, attempt_num)
);
```

## Operational Notes

- `bookings.current_status` is a cache. Business truth is reconstructed from `booking_events`.
- Expiration/deadline policy is computed in code (`booking-effect-policy.ts`); resolved deadlines are stored in `booking_side_effects.expires_at`.
- `booking_side_effect_attempts.api_log_id` links each attempt to provider interaction logging/correlation.
