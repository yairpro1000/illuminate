# Test Plan And E2E Gap Audit - 2026-03-23

## Scope

This audit compares the written test-plan assets and current browser suite inventory against the implemented product behavior.

Artifacts reviewed:

- [manual_testing_companion.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/manual_testing_companion.md)
- `e2e_ui_test_matrix.xlsx`
- current Playwright suite inventory in `apps/site/e2e`

## Manual Testing Companion Gaps

### 1. Captured email guidance is now incomplete

Current implementation supports two real inspection surfaces in mock email mode:

- `/api/__dev/emails*` plus `dev-emails.html`
- request-scoped `mock_email_preview` returned directly from some API flows

Gap:

- [manual_testing_companion.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/manual_testing_companion.md) only documents the `/api/__dev/emails*` plus `dev-emails.html` path
- it does not mention that confirm, cancel, refund-follow-up, contact, event-booking, and booking-event-status flows can expose the exact captured email inline in the same response path

Needed update:

- document when to prefer same-response `mock_email_preview` versus the global captured-email list

### 2. The suggested manual regression session omits current high-value flows

Missing from the current suggested session:

- refund verification after cancel for paid bookings
- pay-later confirmation email `Complete payment` CTA verification
- session-type availability override behavior
- coupon banner and discounted booking flows
- Turnstile retry behavior

### 3. Validation-status notes are stale

The current status section still reads like pre-verification guidance in places. It should be refreshed to reflect that:

- the browser preview spec exists and is live-verified
- the headed refund E2E reruns are passing
- the pay-later/refund flow assertions now use the current inline preview contract

## Workbook Gaps

## Suites sheet gaps

The `Suites` sheet is stale relative to the actual active suite inventory.

Missing active suites:

- `apps/site/e2e/refund-flows.spec.ts`
- `apps/site/e2e/session-type-availability.spec.ts`
- `apps/site/e2e/coupon-israel.spec.ts`
- `apps/site/e2e/coupon-booking-israel.spec.ts`
- `apps/site/e2e/mock-email-inline-preview.spec.ts`

Stale suite status:

- `apps/site/e2e/pay-later-refactor.spec.ts` is marked `Needs refactor`, but the suite has been updated and is currently active

## Matrix sheet gaps

The main matrix does not yet represent several implemented and automated product areas:

1. Refund flows
   - no explicit matrix row covers pay-now cancel/refund
   - no explicit matrix row covers pay-later confirm-plus-cancel refund
2. Session-type availability controls
   - no row covers dedicated availability windows
   - no row covers weekly caps plus force-open/force-closed overrides
   - no row covers submit-time capacity enforcement against a stale review
3. Coupon UX
   - no row covers the Israel coupon banner
   - no row covers discounted pay-now and pay-later booking paths
4. Inline mock email preview
   - no row covers request-scoped preview behavior for booking/contact/confirm flows

Intentional blocked row:

- `E28` organizer auth remains blocked because the current pre-prod environment keeps admin auth disabled

## Current E2E Gaps Vs Product

These are the meaningful remaining automation gaps after the current suite inventory is considered.

### 1. Organizer sign-in remains environment-blocked

Status:

- no meaningful browser E2E currently verifies Cloudflare Access enforcement in the deployed environment

Reason:

- admin auth is disabled in the current target environment

### 2. System-settings save coverage is still missing at the browser level

Current product:

- organizer timing/config management is part of the documented admin scope

Current gap:

- the browser suite covers event editing and session-type editing
- it does not cover a real config/settings save flow

### 3. Refund flow coverage is desktop-only

Current product:

- cancel/refund behavior is user-visible on manage surfaces

Current gap:

- the dedicated refund Playwright coverage currently exists only in desktop form

### 4. Live Stripe settlement artifacts remain manual-only

Current product:

- Stripe-linked manual settlement can surface real receipt/invoice artifacts

Current gap:

- browser automation validates the mock-backed settlement and refund path
- it does not validate a live Stripe out-of-band settlement sequence end-to-end

This is a reasonable manual-only gap, but it should be stated explicitly in the test plan.

## Recommended Test-Plan Update Order

1. Update the workbook `Suites` sheet to match the current active suite inventory.
2. Add matrix rows for refunds, availability overrides, coupons, and inline mock-email preview.
3. Refresh the manual companion so it documents request-scoped `mock_email_preview` and the newly important regression paths.
4. Keep organizer auth and live Stripe artifact verification called out as intentional manual or blocked areas until the environment changes.
