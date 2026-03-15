# ILLUMINATE Website + Booking + Admin Requirements

## 1. Purpose

This document defines the current requirements for the ILLUMINATE public website, booking system, payment flows, self-service management, organizer/admin tooling, and supporting runtime configuration.

Scope included here:

- public website
- public booking and registration flows
- payment and payment-recovery flows
- self-service manage/reschedule/cancel flows
- organizer/admin tooling
- booking/content/timing configuration that directly affects the above

Out of scope:

- PA / Personal Assistant product
- private personal workflows not surfaced by the website or booking/admin system

## 2. Source-of-Truth Hierarchy

When documents disagree, use this order:

1. current code in `apps/site`, `apps/admin`, and `apps/api-booking`
2. [pay_later_refined_flow_2026-03-15.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/pay_later_refined_flow_2026-03-15.md) for pay-later specifics
3. [expected_user_scenarios_freeze_illuminate_2026-03-15.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/expected_user_scenarios_freeze_illuminate_2026-03-15.md) for user-facing acceptance
4. live schema snapshot and technical companion for structural/reference details

## 3. Primary Actors

- Visitor: browses offers, books sessions, registers for evenings, sends contact messages
- Client: confirms bookings, pays, manages bookings, reschedules, cancels
- Organizer: operates the admin UI to manage bookings, content, links, and timing settings

## 4. Product Areas

### 4.1 Public website

The public site must provide:

- a sessions page that exposes only current public 1:1 offers
- an evenings page that exposes upcoming and past events with correct public state
- booking entry points for sessions and events
- reminder signup for unavailable evenings when applicable
- a contact form
- confirmation, payment-success, continue-payment, and manage pages for post-submit flows

### 4.2 Booking domain

The booking system must support:

- free intro 1:1 bookings
- paid 1:1 bookings with pay-now
- paid 1:1 bookings with pay-later
- free event registrations
- paid event registrations
- late-access event registrations through organizer-generated access links

### 4.3 Organizer/admin tooling

The admin scope must support:

- booking list, filtering, detail inspection, and editing
- booking manual payment actions
- client-safe and admin-privileged manage-link generation
- event late-access rotation
- contact-message review
- session-type management
- event management
- timing/config management through DB-backed system settings

## 5. Public Discovery Requirements

### 5.1 Sessions page

The sessions page must:

- show only public/active session offers
- hide non-public or inactive offers
- show price and duration clearly
- route intro offers to the intro booking flow
- route paid 1:1 offers to the paid session booking flow with the correct offer slug
- show an explicit empty state if no public offers exist

### 5.2 Evenings page

The evenings page must:

- separate upcoming and past events
- show each visible event in the correct public state
- show booking CTA only when public registration is open
- show reminder signup CTA when public booking is unavailable but reminders are offered
- avoid false booking CTAs for sold-out or closed states
- show price and capacity context
- offer add-to-calendar on eligible visible upcoming events

### 5.3 Contact page

The contact page must:

- require first name, email, and message
- validate fields inline
- use anti-bot protection when enabled
- show success when contact capture is accepted

## 6. Booking Requirements

### 6.1 Common booking rules

All booking flows must:

- validate anti-bot submission where configured
- enforce real slot availability at submit time for 1:1 bookings
- create or reuse a client identity
- store booking price, currency, and applied coupon snapshot on the booking
- prevent double-winning the same slot
- preserve clear success or failure messaging on the public UI

### 6.2 Booking sources

The system supports two public source families:

- sessions / 1:1 bookings
- events / ILLUMINATE Evenings registrations

### 6.3 Payment modes

The system supports three commercial paths:

- `FREE`
- `PAY_NOW`
- `PAY_LATER`

## 7. Session Booking Requirements

### 7.1 Free intro flow

The free intro flow must:

- let the visitor choose a valid intro slot
- collect booking details
- submit into a pending booking state
- send a confirmation-request email
- become `CONFIRMED` only after the email confirmation link is redeemed

### 7.2 Paid 1:1 pay-now flow

The paid pay-now flow must:

- let the visitor choose a valid paid session slot
- collect booking details
- allow optional coupon application
- route directly into checkout after submit
- confirm the booking after payment settles
- reserve the calendar slot after finalization

### 7.3 Paid 1:1 pay-later flow

The pay-later flow is explicitly refined by the March 15, 2026 source of truth.

Requirements:

- submission behaves like free for the first step
- the first email is only a seriousness / email-ownership confirmation request
- submission does not create the Stripe invoice yet
- submission leaves the booking `PENDING`
- successful email confirmation changes the booking to `CONFIRMED`
- after confirmation, the backend immediately creates a `payments` row with `PENDING`
- after confirmation, the backend synchronously tries to create Stripe invoice state using the customer email
- if Stripe succeeds, the existing payment row is updated with Stripe identifiers and invoice URL and moves to `INVOICE_SENT`
- if Stripe fails, the booking still stays `CONFIRMED`, the payment row remains, and the confirmation email still goes out

### 7.4 Pay-later email behavior

The pay-later confirmation email must:

- use a confirmed-style subject line
- keep the pending-payment body style
- include payment-due information
- include an `INVOICE` row only when an invoice URL exists

### 7.5 Continue-payment behavior

The public continue-payment path must be allowed when:

- booking status is `CONFIRMED`
- and payment status is `PENDING`, `INVOICE_SENT`, `FAILED`, or `CASH_OK`

If the payment row exists but no invoice/checkout URL is available, continue-payment must bootstrap Stripe state from scratch and patch the existing payment row.

## 8. Event Registration Requirements

### 8.1 Free event registration

Free events must:

- require phone at submit time
- enter a pending-email confirmation path
- become confirmed only after the email confirmation link is redeemed

### 8.2 Paid event registration

Paid events must:

- route directly into checkout after submit
- confirm after payment settlement

### 8.3 Late-access event registration

Late-access registration must:

- require a valid unexpired unrevoked access token
- bypass the normal public event cutoff only when the token is valid
- fail clearly when the token is invalid, expired, or revoked

### 8.4 Reminder capture

When public event booking is unavailable but reminder signup is offered:

- reminder signup must succeed idempotently
- it must not create a booking
- it must not create a payment flow

## 9. Confirmation, Recovery, and Self-Service Requirements

### 9.1 Confirmation links

Confirmation links must:

- validate token presence and validity
- confirm eligible bookings
- return the correct next action for the public UI
- show explicit expired behavior for expired links

### 9.2 Payment-success recovery

Payment-success pages must:

- recover the booking via the checkout session id
- expose the next meaningful action even if email is delayed
- support both confirmed and still-finalizing states

### 9.3 Manage links

Manage links must:

- show booking state, timing, location, and client identity
- show payment status and payment due when a payment exists
- show only the actions allowed by current status, booking kind, and self-service policy window
- fail clearly when invalid or expired

### 9.4 Reschedule rules

Rescheduling requirements:

- only eligible 1:1 bookings may self-reschedule
- event bookings do not expose self-reschedule
- locked bookings cannot self-reschedule
- reschedule submission must re-check real slot availability

### 9.5 Cancel rules

Cancellation requirements:

- only eligible bookings may self-cancel
- locked bookings cannot self-cancel online
- canceled 1:1 bookings release their slot again

## 10. Pricing and Coupon Requirements

The system must support coupon-aware pricing for public flows.

Requirements:

- public session and event pricing may visually reflect active coupon logic
- booking submission must persist the actual booking-side coupon snapshot
- checkout/invoice amounts must match the booking snapshot
- invalid coupon codes must fail cleanly

## 11. Timing and Policy Requirements

The system must honor DB-backed timing rules for:

- non-paid confirmation window
- pay-now checkout window
- pay-now reminder grace
- payment due before start
- payment reminder timing and fallback hours
- self-service lock window
- public event cutoff after start
- slot lead time
- late-access link expiry
- admin manage-token expiry
- side-effect processing timeout
- event reminder lead time

These settings are organizer-editable and production-significant.

## 12. Admin Requirements

### 12.1 Booking workbench

Organizer bookings tooling must support:

- filtering by source/date/client/search
- row sorting
- full booking/payment/event/client inspection
- editing supported client and booking fields
- `CASH_OK` marking
- manual payment settlement for eligible bookings
- client-safe manage-link generation
- privileged admin-manage-link generation

### 12.2 Contact messages

Admin contact tooling must support:

- loading rows
- filtering by date/client/text
- opening full-message content

### 12.3 Session types

Session-type tooling must support:

- list/create/edit
- status management
- price and duration editing
- sort order editing
- image-backed field management

### 12.4 Events

Event tooling must support:

- list/edit existing events
- status changes
- payment/free flag changes
- timing and capacity changes
- description/content changes
- late-access link rotation

### 12.5 Config

Config tooling must support:

- listing DB-backed timing settings
- filtering by domain/search
- editing existing settings
- creating new settings

## 13. Background Processing Requirements

The booking system depends on scheduled/background processing for:

- unconfirmed booking expiry
- overdue unpaid booking expiry
- payment reminders
- 24h event reminders
- side-effect dispatch and retry
- calendar sync retry

Important pay-later rules:

- unconfirmed-email expiry applies only while the booking is still `PENDING`
- payment reminder relevance applies while payment is `PENDING` or `INVOICE_SENT`
- payment-expiry verification applies while payment is `PENDING`, `INVOICE_SENT`, or `FAILED`

## 14. Observability and Error Requirements

The system must provide:

- structured diagnostics on public/admin/backend decisions
- stable JSON error envelopes
- CORS-safe responses where applicable
- traceability across booking, payment, calendar, email, jobs, and provider calls

## 15. Non-Functional Requirements

### 15.1 UX

- mobile-first public flows
- clear status copy and next-action recovery
- accessible validation and focus states
- clean failure messages instead of silent dead ends

### 15.2 Operational simplicity

- mock-first local testing remains available
- provider boundaries stay explicit
- business rules are timing-config driven where appropriate

### 15.3 Safety and integrity

- public POST endpoints use anti-bot verification when enabled
- confirm/manage links are tokenized
- booking/payment state transitions must not silently contradict each other
- slot contention must produce one winner and one clean loser

## 16. Out-of-Scope and Known Boundaries

- PA is excluded from this requirement set
- the admin auth bypass flag exists for temporary environments but is not a production business requirement
- the shorter schema companion may normalize live enum-based DB details into authored `text + CHECK` DDL for editor use
