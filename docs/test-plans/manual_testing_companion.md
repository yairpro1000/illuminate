# ILLUMINATE Manual Testing Companion

Use this companion with the E2E workbook at [e2e_ui_test_matrix.xlsx](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/e2e_ui_test_matrix.xlsx).

This document is the lean manual execution guide for the website, booking flows, payment recovery, self-service management, and organizer/admin UI. It follows the latest code in `apps/site`, `apps/admin`, `apps/api-booking`, and the refined pay-later contract in [pay_later_refined_flow_2026-03-15.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/pay_later_refined_flow_2026-03-15.md).

## 1. Test Order

Run in this order:

1. P0 public booking and payment flows
2. P0 manage, reschedule, cancel, and expiry behavior
3. P0 slot-contention and stale-slot recovery
4. P1 captured-email payload and browser-preview checks
5. P1 organizer/admin booking operations
6. P1 public content-state checks for sessions and evenings
7. P1 contact and anti-bot flows
8. P2 session-type, event, config, and image-upload edits

## 2. Release-Blocking Outcomes

Treat these as blockers:

- a primary public CTA opens the wrong booking or event flow
- free intro or free evening registration skips email confirmation
- pay-now does not reach checkout or payment-success recovery cleanly
- pay-later no longer follows the confirmation-first contract
- a valid manage link cannot load a valid booking
- reschedule or cancel is offered when it should not be, or blocked when it should be allowed
- two users can both win the same slot
- organizer booking tools cannot load or cannot mutate the intended records
- public event state is wrong enough to show bookable versus sold-out or closed status incorrectly

## 3. Current Pay-Later Truth

Manual checks for pay-later must use this exact contract:

- submit behaves like free: the visitor sees "booking received" and must confirm by email first
- submission leaves the booking `PENDING`
- confirmation changes the booking to `CONFIRMED`
- confirmation then creates the payment row and attempts Stripe invoice bootstrap
- the confirmation email subject is confirmation-style, not immediate action-needed style
- the email body keeps the pending-payment language
- the email includes an `INVOICE` row only when an invoice URL exists
- if Stripe bootstrap failed, the confirmation still succeeds and `continue-payment` must rebuild Stripe state from scratch
- `continue-payment` must redirect into checkout, not to an invoice document page
- `continue-payment` is allowed for booking `CONFIRMED` with payment `PENDING`, `INVOICE_SENT`, `FAILED`, or `CASH_OK`

Older manual notes or stale UI automation that assume a submit-time pay-later invoice are obsolete.

## 4. Environment Checklist

Fill these in before running:

- public site base URL:
- admin base URL:
- API base URL:
- organizer auth mode:
- email mode:
- captured email preview access:
- payments mode and Stripe test card or mock flow:
- anti-bot mode:
- one public intro offer URL:
- one public paid session offer URL:
- one public free event URL:
- one public paid event URL:
- one valid confirmation link:
- one expired confirmation link:
- one valid manage link:
- one expired manage link:
- one valid late-access link:
- one rotated or expired late-access link:
- bug tracker or execution-notes location:

For deterministic email-preview testing, set:

- `EMAIL_MODE=mock`
- `ANTIBOT_MODE=mock`

The preview routes are intentionally tied to captured email mode. If email is being sent to Resend, `/api/__dev/emails`, `/api/__dev/emails/:emailId`, `/api/__dev/emails/:emailId/html`, and `dev-emails.html` are not the correct inspection surface.

## 5. Captured Email Preview Workflow

Use this flow when validating email content in mock mode:

1. Force email service to `mock`.
2. Force antibot to `mock` for deterministic booking setup.
3. Create a booking or registration that emits the target email.
4. Open `GET /api/__dev/emails` to find the captured email id and preview URLs.
5. Open `GET /api/__dev/emails/:emailId` when you need the raw captured payload fields for assertions.
6. Open `GET /api/__dev/emails/:emailId/html` for raw HTML inspection.
7. Open `dev-emails.html` or `dev-emails.html?email_id=<id>` to preview the real captured HTML in the iframe.

What to inspect:

- `from`
- `replyTo`
- `subject`
- `text`
- `html`
- real CTA href values inside the rendered email HTML

Do not validate against a custom fake preview body. The whole point of this flow is to inspect the same production-bound payload that the Resend path would have sent.

## 6. Must-Cover Manual Assertions

Always verify these, even if the automated suite already covers them:

- the booked slot disappears after confirmation or payment finalization
- cancel returns a slot to availability
- reschedule re-checks live availability
- a stale-slot loser gets a clean recovery state instead of a silent failure
- reminder signup on an unavailable evening does not create a booking
- invalid or expired confirmation and manage links fail explicitly
- admin manual settlement and manage-link generation respect booking state
- captured email preview shows the real HTML and the expected CTA destinations

## 7. Suggested Session

For one focused regression pass:

1. Run one free intro booking through confirmation, manage, and cancel.
2. Run one paid session with pay-now through checkout success.
3. Run one paid session with pay-later through submit, email confirmation, and continue-payment.
4. Use `dev-emails.html` to inspect the captured confirmation-request email and its real CTA links.
5. Run one free evening registration and one paid evening registration.
6. Run one late-access evening registration after rotating the link in admin.
7. Verify one slot-contention path with two browsers.
8. Verify organizer bookings, contact messages, one session-type edit, one event edit, and one config save.

## 8. Bug Logging Format

Use one line per finding:

`Observed: ... | Expected: ... | Steps/Link: ... | Env: ...`

If the bug touches pay-later, include:

- booking status after submit
- booking status after confirmation
- payment status
- whether invoice URL existed
- whether continue-payment recovered or failed

If the bug touches captured email preview, include:

- email id
- email kind
- whether `html` existed
- failing route or preview page URL
- unexpected CTA href or missing element

## 9. Current Validation Status

- API-side tests for captured email payload and preview routes passed.
- Backend type-check passed.
- The Playwright browser-preview spec is in place.
- For live end-to-end verification, deploy the latest fixes first and then rerun the preview spec against the updated target environment.

## 10. Out of Scope For This Pack

- PA flows
- broad browser-matrix expansion
- deep accessibility audit
- performance or load testing
- low-probability edge cases not tied to current product risk
