# product_spec.md

## 1. System Overview

Platform for:
- 1:1 bookings
- Free and paid event bookings
- Mock-first payments in dev
- Google Calendar synchronization
- Automated reminders and lifecycle enforcement

Low-friction UX with business-protective payment and cancellation logic.

------------------------------------------------------------------------

## 2. Core User Flows

### 2.1 1:1 Booking -- Pay Now (paid session only)

1.  User selects a paid session slot.
2.  Booking created in `pending_payment`.
3.  Checkout hold applied.
4.  Stripe success → `confirmed`.
5.  Calendar event created or refreshed.
6.  Confirmation email is attempted.
7.  Checkout success page can recover the manage link even if email is delayed.

### 2.2 1:1 Booking -- Pay Later (paid session only)

1.  Booking created in `pending_email`.
2.  Email confirmation required.
3.  After confirmation → `pending_payment`.
4.  Calendar event created.
5.  Checkout recovery URL persisted with the payment record.
6.  Payment due at T-24h.
7.  If unpaid at due time → auto-cancel.

### 2.3 1:1 Intro Booking

1.  Intro booking created in `pending_email`.
2.  Email confirmation required.
3.  After confirmation → `confirmed`.
4.  No payment lifecycle is created for intros.
5.  Reminder before session if opted in.

### 2.4 Free Event Booking

1.  Phone required.
2.  Booking created in `pending_email`.
3.  Email confirmation (15m window).
4.  Seat is only secured once confirmed.
5.  +2h follow-up if unconfirmed.
6.  Reminder before event if opted in.

### 2.5 Paid Event Booking

1.  Booking → `pending_payment`.
2.  Checkout hold applied.
3.  Stripe success → `confirmed`.
4.  No separate +2h unpaid reminder exists.
5.  Invoice included in confirmation when available.

### 2.6 Late / Walk-In Event Booking

1.  PA generates or shares an event-scoped late-access link.
2.  Link may stay active until up to 2h after event end.
3.  Attendee books as a normal client booking.
4.  Capacity is still enforced.

------------------------------------------------------------------------

## 3. Lifecycle Rules

- Payment due reminder logic:
  - Prefer T-6h before due.
  - If 22:00--08:00 → 18:00 day before.
  - If missed → 08:00 next morning.
- Event capacity currently counts confirmed bookings plus active paid checkout holds.
- One booking row represents one attendee.
- There is no guest / plus-one system in the current design.
- Events move to “past events” after the configured post-start window and stop showing normal registration.
- Stripe webhook is payment authority.

------------------------------------------------------------------------

## 4. Email Requirements

All confirmations include:
- Address
- Google Maps link
- Manage/reschedule link
- Invoice link (if paid)

Follow-ups:
- +2h unconfirmed reminder for pending-email flows
- 24h event/session reminder (opt-in)

Reminder signup CTA:
- Future sold-out events should offer signup for future ILLUMINATE Evenings reminders.
- Past events should offer the same reminder signup above the “past events” list.

------------------------------------------------------------------------

## 5. Error Handling Overview

- Expired checkout holds → status = expired.
- Failed webhook retries handled idempotently.
- Calendar failures logged and retried.
- Email delivery is best-effort in this dev stage; public pages must expose recovery actions.
- Duplicate webhook events must not create duplicate state transitions.
