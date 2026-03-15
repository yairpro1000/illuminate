# Booking Domain Refactor Spec for the Coder

This document is the source of truth for the booking-domain refactor. It defines the final vocabulary, enum/check sets, orchestration rules, and trigger-to-intent mapping.

## Core principle

- **Events** answer: **what happened**.
- **Side effects** answer: **what must be done now**.
- **Payments** answer: **financial reality**.
- **Cron** is only the wake-up mechanism for due internal verification intents. It is **not** a business source.

## 1. Domain model

### Tables and what they mean

- `bookings` stores **current booking reality**.
- `payments` stores **current payment reality**.
- `booking_events` stores **facts that happened** and may trigger downstream work.
- `booking_side_effects` stores **queued responsibilities**:
  - external-provider actions, or
  - internal verification actions.
- `booking_side_effect_attempts` stores the **execution / retry audit trail**.

### How to read an event

An event answers 3 questions:

1. **Who initiated the chain?**
   - `PUBLIC_UI`
   - `ADMIN_UI`
   - `SYSTEM`
   - `WEBHOOK`
2. **What happened?**
   - for example: `BOOKING_FORM_SUBMITTED`, `BOOKING_EXPIRED`
3. **What needs to happen now?**
   - create side effects

### How to read a side effect

A side effect answers 2 questions:

1. **What action must be performed?**
2. **Which source/domain/provider is responsible for that action?**

Examples:

- `SEND_BOOKING_CONFIRMATION_REQUEST` + `EMAIL`
- `CREATE_STRIPE_CHECKOUT` + `PAYMENT`
- `UPDATE_CALENDAR_SLOT` + `CALENDAR`
- `VERIFY_EMAIL_CONFIRMATION` + `SYSTEM`

For internal verification side effects, execution may reveal that a **new event** happened. If so:

- emit the new event
- let policy create the next side effects

## 2. Final enum / check sets

### `bookings`

#### `booking_type`
- `FREE`
- `PAY_NOW`
- `PAY_LATER`

#### `current_status`
- `PENDING`
- `CONFIRMED`
- `CANCELED`
- `EXPIRED`
- `COMPLETED`
- `NO_SHOW`

### `payments`

#### `status`
- `PENDING`
- `SUCCEEDED`
- `FAILED`
- `REFUNDED`

### `booking_events`

#### `source`
- `PUBLIC_UI`
- `ADMIN_UI`
- `SYSTEM`
- `WEBHOOK`

#### `event_type`
- `BOOKING_FORM_SUBMITTED`
- `BOOKING_RESCHEDULED`
- `BOOKING_CANCELED`
- `BOOKING_EXPIRED`
- `PAYMENT_SETTLED`
- `REFUND_COMPLETED`

### `booking_side_effects`

#### `source`
- `EMAIL`
- `CALENDAR`
- `PAYMENT`
- `WHATSAPP`
- `SYSTEM`

#### `status`
- `PENDING`
- `SUCCESS`
- `FAILED`
- `DEAD`

#### `effect_intent`
- `SEND_BOOKING_CONFIRMATION_REQUEST`
- `SEND_BOOKING_CONFIRMATION`
- `SEND_PAYMENT_LINK`
- `SEND_PAYMENT_REMINDER`
- `SEND_BOOKING_CANCELLATION_CONFIRMATION`
- `SEND_BOOKING_EXPIRATION_NOTIFICATION`
- `SEND_EVENT_REMINDER`
- `CREATE_STRIPE_CHECKOUT`
- `VERIFY_EMAIL_CONFIRMATION`
- `VERIFY_STRIPE_PAYMENT`
- `CREATE_STRIPE_REFUND`
- `RESERVE_CALENDAR_SLOT`
- `UPDATE_CALENDAR_SLOT`
- `CANCEL_CALENDAR_SLOT`

### `booking_side_effect_attempts`

#### `status`
- `SUCCESS`
- `FAILED`

## 3. Hard execution rules

1. **Events create side effects.**
2. A side effect may create a new event **only if** its execution reveals that a new fact just happened.
3. Cron does **not** create business events by itself. It only wakes the system to execute due internal verification side effects.
4. `JOB` is **not** a business source and must not exist in `booking_events.source`.
5. `EXPIRE_BOOKING` is **not** a side-effect intent. Expiration is the result of internal verification logic.
6. `SEND_PAYMENT_LINK` must **never** be created in the `PAY_NOW` flow.
7. For long-lived verification flows, keep **one** pending side-effect row and use `expires_at` as the next meaningful checkpoint. Do **not** spawn duplicate verification rows every sweep round.
8. A side-effect row marked `SUCCESS` must mean that the named action **really happened**.
9. Booking lifecycle and payment lifecycle are separate:
   - booking state lives on `bookings`
   - payment state lives on `payments`
10. If verification finds that nothing changed yet, do **not** create a fake event. Just leave the side effect pending until its next checkpoint.

## 4. Trigger-to-intent mapping format

Use this exact column set for the orchestration matrix:

`#, booking_type, source, trigger_kind, trigger_name, creates_now, creates_pending (+ expires_at rule), booking_before, booking_after, payment_before, payment_after, notes`

## 5. Core orchestration matrix

| # | booking_type | source | trigger_kind | trigger_name | creates_now | creates_pending (+ expires_at) | booking_before | booking_after | payment_before | payment_after | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | FREE | PUBLIC_UI | event | BOOKING_FORM_SUBMITTED | `SEND_BOOKING_CONFIRMATION_REQUEST` | `VERIFY_EMAIL_CONFIRMATION @ now+15m` | - | `PENDING` | - | - | No payment row. |
| 2 | PAY_LATER | PUBLIC_UI | event | BOOKING_FORM_SUBMITTED | `SEND_BOOKING_CONFIRMATION_REQUEST` | `VERIFY_EMAIL_CONFIRMATION @ now+15m` | - | `PENDING` | - | - | Payment link is not sent yet. |
| 3 | PAY_NOW | PUBLIC_UI | event | BOOKING_FORM_SUBMITTED | `CREATE_STRIPE_CHECKOUT` | `VERIFY_STRIPE_PAYMENT @ payment_window_end` | - | `PENDING` | - | `PENDING` | Do not create `SEND_PAYMENT_LINK` here. |
| 4 | FREE | SYSTEM | function | `VERIFY_EMAIL_CONFIRMATION` | If confirmed: `RESERVE_CALENDAR_SLOT` + `SEND_BOOKING_CONFIRMATION`. If expired: emit `BOOKING_EXPIRED`. | - | `PENDING` | `CONFIRMED` or `EXPIRED` | - | - | No fake event if still waiting. |
| 5 | PAY_LATER | SYSTEM | function | `VERIFY_EMAIL_CONFIRMATION` | If confirmed: `SEND_PAYMENT_LINK`. If expired: emit `BOOKING_EXPIRED`. | - | `PENDING` | `PENDING` or `EXPIRED` | - | - | Booking stays `PENDING` until payment settles. |
| 6 | PAY_NOW | SYSTEM | function | `VERIFY_STRIPE_PAYMENT` | If settled: emit `PAYMENT_SETTLED`. If reminder threshold crossed: `SEND_PAYMENT_REMINDER`. If final deadline crossed: emit `BOOKING_EXPIRED`. | Keep the same `VERIFY_STRIPE_PAYMENT` row pending until the next checkpoint. | `PENDING` | `PENDING` / `CONFIRMED` / `EXPIRED` | `PENDING` | `SUCCEEDED` or `FAILED` / unchanged | Use `expires_at` as next checkpoint. |
| 7 | PAY_LATER or PAY_NOW | WEBHOOK or SYSTEM | event | `PAYMENT_SETTLED` | `RESERVE_CALENDAR_SLOT` + `SEND_BOOKING_CONFIRMATION` | - | `PENDING` | `CONFIRMED` | `PENDING` | `SUCCEEDED` | This is when the booking becomes truly confirmed after payment. |
| 8 | ANY | PUBLIC_UI or ADMIN_UI | event | `BOOKING_RESCHEDULED` | `UPDATE_CALENDAR_SLOT` | - | `CONFIRMED` | `CONFIRMED` | unchanged | unchanged | Store old/new timestamps in payload for analytics. |
| 9 | ANY | PUBLIC_UI or ADMIN_UI | event | `BOOKING_CANCELED` | `CANCEL_CALENDAR_SLOT` + `SEND_BOOKING_CANCELLATION_CONFIRMATION` + `CREATE_STRIPE_REFUND` (if paid and refund-eligible) | - | `PENDING` or `CONFIRMED` | `CANCELED` | `SUCCEEDED` or - | `REFUNDED` later or unchanged | Refund branch only when applicable. |
| 10 | ANY | SYSTEM | event | `BOOKING_EXPIRED` | `CANCEL_CALENDAR_SLOT` + `SEND_BOOKING_EXPIRATION_NOTIFICATION` | - | `PENDING` | `EXPIRED` | `PENDING` or - | `FAILED` or unchanged | Expiration is an event, not an intent. |
| 11 | ANY paid | WEBHOOK or SYSTEM | event | `REFUND_COMPLETED` | - | - | `CANCELED` | `CANCELED` | `SUCCEEDED` | `REFUNDED` | Booking remains `CANCELED`; payment changes to `REFUNDED`. |

## 6. Consequences for the codebase

1. Refactor from the model downward:
   - schema
   - TypeScript enums/types
   - event-to-side-effect policy
   - service/orchestration layer
   - sweeper
   - UI adapters
2. Delete old mixed concepts such as:
   - `JOB` as a business source
   - `EXPIRE_BOOKING` as an intent
   - event names that encode payment mode
3. Add explicit `booking_type` to `bookings` and branch flows using that field rather than proliferating event names.
4. Normalize casing consistently to uppercase snake case for the booking domain and payment statuses.

## 7. Concrete coder tasks

1. Rewrite `010_booking_centric_schema.sql` to match this vocabulary and enum set.
2. Create follow-up migration(s) for existing environments:
   - old value -> new value mappings
   - dropped constraints
   - re-added constraints
   - backfills for `booking_type` if needed
3. Refactor all TypeScript constants, unions, runtime validators, and DB repository mappings to the new names.
4. Rewrite event-policy logic so the matrix in this document becomes the single truth source.
5. Rewrite sweeper logic so it only processes due pending side effects and uses `expires_at` as the next checkpoint instead of spawning duplicate verification rows.
6. Keep admin/public handlers thin: they should emit the correct event and delegate orchestration to the central service layer.
7. Preserve analytics value by storing old/new reschedule timestamps in `booking_events.payload` for `BOOKING_RESCHEDULED`.

## 8. Notes and guardrails

- If a payment fails in the UI and no downstream action is required, do **not** create a business event just for decoration.
- `BOOKING_COMPLETED`, `BOOKING_NO_SHOW`, and `BOOKING_CONFIRMED` are booking states, not event types in this model.
- If later you need richer repeated-reschedule analytics, first try event payloads before adding a dedicated reschedule table.
- For v1, manual monitoring of failed / stuck side effects is acceptable.

