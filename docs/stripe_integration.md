# stripe_integration.md

## 1. Stripe Objects Used

-   Checkout Sessions
-   Payment Intents
-   Invoices
-   Webhooks

------------------------------------------------------------------------

## 2. Checkout Configuration

-   Mode: payment
-   Metadata includes `booking_id`
-   Multi-currency enabled
-   TWINT enabled (if available)

------------------------------------------------------------------------

## 3. Invoice Creation Rules

-   Stripe auto-generates invoice upon successful payment.
-   Invoice URL stored in payments table.
-   Included in confirmation email.

------------------------------------------------------------------------

## 4. Webhook Events Handled

-   checkout.session.completed
-   payment_intent.succeeded
-   payment_intent.payment_failed (optional handling)

Webhook must: - Verify Stripe signature. - Be idempotent. - Update
payments + booking state.

------------------------------------------------------------------------

## 5. Failure Recovery Logic

-   Duplicate webhook events ignored safely.
-   If calendar creation fails, retry with job.
-   Email delivery is best-effort in this dev stage; public confirmation and checkout-success pages must expose the next action directly.
