# product_spec.md

## 1. System Overview

Platform for: - 1:1 coaching bookings - Free and paid event
registrations - Stripe payments (TWINT enabled) - Google Calendar
synchronization - Automated reminders & lifecycle enforcement

Low-friction UX with business-protective payment and cancellation logic.

------------------------------------------------------------------------

## 2. Core User Flows

### 2.1 1:1 Booking -- Pay Now

1.  User selects slot.
2.  Booking created in `pending_payment`.
3.  15-minute checkout hold.
4.  Stripe success → `confirmed`.
5.  Calendar event created.
6.  Confirmation email sent (maps + manage link + invoice).

### 2.2 1:1 Booking -- Pay Later

1.  Booking created in `pending_email`.
2.  Email confirmation required.
3.  After confirmation → `pending_payment`.
4.  Calendar event created.
5.  Payment due at T-24h.
6.  If unpaid at due time → auto-cancel.

### 2.3 Free Event Registration

1.  Phone required.
2.  Email confirmation (15m window).
3.  +2h follow-up if unconfirmed.
4.  24h reminder if opted in.

### 2.4 Paid Event Registration

1.  Registration → `pending_payment`.
2.  15m hold.
3.  Stripe success → `confirmed`.
4.  +2h unpaid reminder.
5.  Invoice included in confirmation.

------------------------------------------------------------------------

## 3. Lifecycle Rules

-   Payment due reminder logic:
    -   Prefer T-6h before due.
    -   If 22:00--08:00 → 18:00 day before.
    -   If missed → 08:00 next morning.
-   Capacity secured only when status = confirmed.
-   Stripe webhook is payment authority.

------------------------------------------------------------------------

## 4. Email Requirements

All confirmations include: - Address - Google Maps link -
Manage/reschedule link - Invoice link (if paid)

Follow-ups: - +2h unconfirmed/unpaid reminder - 24h event/session
reminder (opt-in)

------------------------------------------------------------------------

## 5. Error Handling Overview

-   Expired checkout holds → status = expired.
-   Failed webhook retries handled idempotently.
-   Calendar failures logged and retried.
-   Duplicate webhook events must not create duplicate state
    transitions.
