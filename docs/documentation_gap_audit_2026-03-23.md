# Documentation Gap Audit - 2026-03-23

## Scope

This audit maps the current documentation set against the implemented website, booking, payment, manage, cancel, refund, and admin behavior as of 2026-03-23.

## Source Of Truth Used For This Audit

- code in `apps/site`, `apps/admin`, and `apps/api-booking`
- [requirements.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/requirements.md)
- [technical_companion.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/technical_companion.md)
- [expected_user_scenarios_freeze_illuminate_2026-03-15.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/expected_user_scenarios_freeze_illuminate_2026-03-15.md)
- [pay_later_refined_flow_2026-03-15.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/pay_later_refined_flow_2026-03-15.md)
- [public_schema_snapshot_2026-03-23.sql](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/public_schema_snapshot_2026-03-23.sql)
- [public_schema_editor_ddl_2026-03-23.sql](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/public_schema_editor_ddl_2026-03-23.sql)

## Schema Artifact Refresh Status

Completed:

- `docs/public_schema_snapshot_2026-03-23.sql` is now the current literal dump.
- `docs/public_schema_editor_ddl_2026-03-23.sql` is the current editor companion.
- older schema artifacts were archived to `docs/old/`, including the prior `2026-03-22` and `2026-03-15` dump and companion pairs.

Follow-up already applied:

- the March 15 freeze now points to the archived March 15 schema snapshot under `docs/old/`.

## Frozen Scenario Gaps

The current freeze is still useful, but it is no longer complete enough to serve as the sole user-facing acceptance baseline.

### 1. Pay-later confirmation email expectations are stale

Current implementation:

- the post-confirmation pay-later email now includes a `Complete payment` CTA alongside the manage path
- the CTA resolves to `continue-payment.html`
- this is covered in backend email payload tests and browser E2E checks

Current freeze gap:

- `S07` and the related pay-later expectations still emphasize invoice-row behavior, but they do not explicitly freeze the `Complete payment` CTA in the confirmation email

Required doc update:

- update the freeze and requirements to treat `Complete payment` in the confirmed-but-unpaid email as part of the current accepted pay-later UX

### 2. Paid cancellation and refund behavior is under-specified

Current implementation:

- eligible paid booking cancellation can synchronously trigger refund creation
- refunded bookings persist receipt and credit-note URLs on the payment row
- manage UI surfaces refunded-state artifacts
- refund confirmation email is sent on the successful refund path

Current freeze gap:

- `S15` only says paid bookings may later trigger refund handling
- no frozen scenario describes the user-visible refunded end state, refund email, or manage-page artifact links

Required doc update:

- add a dedicated refund scenario or expand `S15` so refunded paid cancellations freeze their actual end-state behavior

### 3. Coupon behavior is missing from the frozen user scenarios

Current implementation:

- Israel coupon banner behavior exists on supported public surfaces
- discounted pay-now and pay-later flows persist discounted booking/payment amounts
- coupon removal and manual reapplication are part of the real booking UX

Current freeze gap:

- the freeze does not include coupon-banner behavior or discounted booking journeys

Required doc update:

- add at least one public coupon discovery scenario and one discounted booking scenario

### 4. Turnstile user behavior is missing from the frozen user scenarios

Current implementation:

- booking and contact forms have explicit Turnstile validation behavior
- booking failure-and-retry and contact success paths are automated

Current freeze gap:

- the freeze treats anti-bot behavior only as a dependency, not as an explicit user-facing scenario

Required doc update:

- add one explicit anti-bot scenario for booking retry and one for successful protected contact submission, or consciously declare these out of freeze scope

### 5. Admin-configured availability behavior is missing from the frozen user scenarios

Current implementation:

- session-type-specific availability windows
- weekly caps
- force-open and force-closed overrides
- submit-time capacity rechecks

Current freeze gap:

- `S01` and `S23` cover public offers and slot contention, but not the organizer-to-public availability control paths now covered in E2E

Required doc update:

- extend the freeze or add an admin/public coupling scenario covering session-type availability overrides

## Documentation Gaps Vs Current Implementation

### Requirements gaps

1. [requirements.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/requirements.md) describes coupon-aware pricing, but it does not freeze the public Israel-banner journey or the remove-and-reapply coupon behavior already treated as real product surface in E2E.
2. [requirements.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/requirements.md) describes cancellation and manual settlement, but it does not describe the current refunded end state well enough:
   - refund confirmation email
   - receipt URL
   - credit-note URL
   - refunded manage-page state
3. [requirements.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/requirements.md) does not explicitly state that the pay-later confirmation email now includes `Complete payment`.

### Technical companion gaps

1. [technical_companion.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/technical_companion.md) still frames captured-email inspection mainly around `/api/__dev/emails*` plus `dev-emails.html`, but current implementation also exposes request-scoped `mock_email_preview` payloads on:
   - public booking submit responses
   - confirm responses
   - cancel responses
   - contact responses
   - event booking responses
   - booking-event status responses
2. The browser E2E inventory in [technical_companion.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/technical_companion.md) is now incomplete because it does not mention active suites for:
   - refund flows
   - session-type availability
   - coupon banner and coupon booking flows
   - inline mock-email preview coverage
3. The operational note that “some older automated tests may lag behind the March 15, 2026 pay-later refinement” is stale. The core pay-later suites were updated and are now current.

## Recommended Documentation Update Order

1. Refresh the frozen scenario document with the missing current product scenarios.
2. Refresh `requirements.md` for refund artifacts and pay-later confirmation-email CTA expectations.
3. Refresh `technical_companion.md` so the testing and email-preview sections match the current implementation and suite inventory.
4. Refresh the test-plan docs and workbook from the current audit in [docs/test-plans/test_plan_and_e2e_gap_audit_2026-03-23.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/test_plan_and_e2e_gap_audit_2026-03-23.md).
