# Pay-Later Refined Flow

**Date:** 2026-03-15  
**Status:** Source of truth for the pay-later flow as refined on 2026-03-15  
**Scope:** 1:1 session pay-later behavior, follow-up payment bootstrap, continue-payment rules, and sweeper behavior

This document supersedes older pay-later expectations anywhere they conflict.

## Core rule

Pay-later now splits into two distinct stages:

1. **Email seriousness check**
2. **Payment initiation after confirmation**

That means pay-later no longer creates or sends the Stripe invoice at form submission time.

## Flow summary

### 1. Public form submission

When a visitor submits a pay-later booking:

- create the booking with `bookings.current_status = PENDING`
- do **not** create the Stripe invoice yet
- do **not** send the payment-pending confirmation email yet
- send the same first confirmation-request email used by the free flow
- create the email-confirmation verification side effect / sweep path

This first email exists only to confirm the person is serious and has access to the email address.

### 2. Email confirmation accepted

When the person clicks the confirmation link within the allowed confirmation window:

- update the booking to `bookings.current_status = CONFIRMED`
- immediately insert a row into `payments` with `status = PENDING`
- synchronously call Stripe from the backend to create the payment artifact
- include the customer email in the Stripe request so Stripe can also send the invoice
- update the same payment row with Stripe identifiers and invoice URL if Stripe succeeds
- send the final booking confirmation email

For pay-later, confirmation of the email is what confirms the booking. Payment is still pending after that.

## Final confirmation email for pay-later

### Subject

Use a confirmed-style subject, not an action-needed subject:

- **Session:** `Your session on ___ is confirmed`
- **Event:** `You're confirmed - <event name>`

### Body

Keep the current pay-later body style that explains payment is still pending.

### Details table

After the `PAYMENT DUE` row, add:

- `INVOICE | Click here`

Only add that row when an invoice URL exists.

## Stripe bootstrap failure at confirmation time

This is a required non-fatal path.

If the system has already inserted the `payments` row but the Stripe invoice bootstrap fails:

- do **not** fail the booking confirmation
- keep the booking `CONFIRMED`
- keep the payment row in place
- keep the payment status as `PENDING`
- send the confirmation email anyway
- omit the invoice row if there is no invoice URL

The user must still be able to complete payment later through `/continue-payment`.

## Continue-payment rule

Show or allow **Complete Payment** only when both of these are true:

1. `bookings.current_status = CONFIRMED`
2. `payments.status` is one of:
   - `PENDING`
   - `INVOICE_SENT`
   - `FAILED`
   - `CASH_OK`

### Notes

- `CASH_OK` does not block online payment. It only records that cash is an allowed/manual arrangement.
- `FAILED` stays eligible for `/continue-payment`.

## Continue-payment fallback bootstrap

`/continue-payment` is a checkout recovery path, not an invoice-document redirect.

If the payment row exists but there is still no checkout URL, `/continue-payment` must bootstrap payment from scratch.

An existing invoice URL may still appear in emails or admin views, but it does not count as the `/continue-payment` target.

That fallback must:

- reuse the existing payment row
- create Stripe state from scratch, like the pay-now bootstrap path
- update the existing payment row with the new Stripe checkout details
- redirect the user into payment if bootstrap succeeds

This fallback exists specifically for the case where the booking confirmation succeeded but the original Stripe invoice bootstrap failed.

## Payment status expectations

Relevant pay-later statuses in this flow:

- `PENDING`
  - payment row exists
  - Stripe invoice may not exist yet
- `INVOICE_SENT`
  - Stripe invoice exists
  - invoice URL is available
- `FAILED`
  - online retry is still allowed
  - expiry logic still treats this as unpaid
- `CASH_OK`
  - online retry is still allowed
- `SUCCEEDED`
  - payment settled
- `REFUNDED`
  - payment refunded

## Sweeper rules

### Confirmation-window sweeper

`nonPaidConfirmationWindowMinutes` applies only while:

- `bookings.current_status = PENDING`

If the first email was never confirmed in time, the booking can expire from that pending state.

### Payment reminder sweeper

`SEND_PAYMENT_REMINDER` is relevant only while:

- `payments.status = PENDING`
- or `payments.status = INVOICE_SENT`

### Payment expiry / verification sweeper

`paymentDueBeforeStartHours` and the unpaid-expiry verification path apply while:

- `payments.status = PENDING`
- or `payments.status = INVOICE_SENT`
- or `payments.status = FAILED`

So `FAILED` still counts as unpaid for expiry purposes.

## Behavioral difference vs free

### Same as free

- first email is a confirmation request
- booking starts as `PENDING`
- email confirmation moves the booking to `CONFIRMED`

### Different from free

After confirmation, pay-later continues into payment initiation:

- create payment row
- bootstrap Stripe invoice if possible
- send confirmed booking email that still says payment is pending
- allow later payment completion through **Complete Payment**

## Short state timeline

### Happy path

1. Submit pay-later form
2. Booking = `PENDING`
3. Confirmation-request email sent
4. User confirms email
5. Booking = `CONFIRMED`
6. Payment row inserted as `PENDING`
7. Stripe invoice bootstrap succeeds
8. Payment = `INVOICE_SENT`
9. Final confirmation email sent with invoice link
10. User pays later
11. Payment = `SUCCEEDED`

### Fallback path

1. Submit pay-later form
2. Booking = `PENDING`
3. Confirmation-request email sent
4. User confirms email
5. Booking = `CONFIRMED`
6. Payment row inserted as `PENDING`
7. Stripe invoice bootstrap fails
8. Final confirmation email still sent, without invoice link
9. User opens **Complete Payment**
10. `/continue-payment` bootstraps Stripe from scratch
11. Existing payment row is updated
12. User pays
