---
name: ui-automated-e2e-test
description: Design, scope, implement, run, and report lean automated end-to-end UI tests for web applications from project-specific docs supplied in the chat. Use when Codex must read frozen scenarios, test plans, acceptance docs, architecture notes, or constraints, decide what belongs in a small P0/P1 browser suite versus manual coverage, propose the automation scope for approval, and then execute Playwright-first UI automation with deterministic setup, strong business assertions, and concise review artifacts.
---

# UI Automated E2E Test

Build a small, reviewable UI end-to-end suite that protects user-facing business invariants during active product work. Default to Playwright unless the user explicitly requests another framework.

Keep the suite lean. Automate what must not quietly break. Leave subjective, unstable, or low-value checks manual unless the user explicitly asks otherwise.

## Non-Negotiable Safety Caveat

Before scoping, implementing, or running any automated UI test, enforce all of the following:

- Never use a real payment provider integration for automated tests. Keep all payment transactions, payment attempts, and payment-side effects strictly mock-only. If there is any doubt, or if mock scaffolding does not already exist, stop and ask the user immediately.
- Never read real customer or client data from the database, files, or documents for use in tests. Never send real emails or messages. Never change or delete real customer or business data as part of automated testing.
- Never update or delete existing business data that was not created by the current test run. Unless the user explicitly authorizes otherwise, automated tests must create fresh test data first. Only data created by that same test run may be updated or deleted during cleanup or scenario execution.

## Operating Rules

- Prefer a tiny P0/P1 smoke suite over broad ceremonial coverage.
- Start with a navigation smoke pass before deeper scenario automation.
- Prefer strong assertions about business outcomes over page mechanics.
- Prefer deterministic setup, teardown, and data control.
- Treat frontend console errors and failed network requests observed during the tested scenarios as candidate product bugs, not background noise.
- Use separate browser contexts or sessions for multi-user flows.
- Use helper utilities for controlled link retrieval, deliberate job triggering, and time simulation where needed.
- Avoid hard sleeps unless there is no controlled alternative.
- Avoid abstraction pyramids unless repeated usage clearly justifies them.
- Separate UI product-contract coverage from provider-specific integration checks when sensible.

The tested domains should be clean by the end of the suite run:

- No unexpected frontend errors left unreviewed.
- No unexplained failed network requests in the exercised flows.
- No tolerance for "the flow passed but the console was noisy".
- No broken primary navigation path left undiscovered at the start of the run.

## Default Technical Decisions

### Email Flows

- Do not default to real inbox polling.
- Prefer retrieving or generating the tokenized link through controlled backend or test mechanisms.
- Open that link back in the browser and continue the flow there.
- If the token or link must be one-time-use, verify both valid-use and rejected reuse or expired cases when those cases are in scope.
- Treat real email delivery and rendering as separate manual or focused integration coverage unless the user explicitly asks for UI coverage.

### Cron, Sweepers, and Async Side Effects

- Do not wait for real cron time.
- Prefer controlled time advancement or direct state setup over passive waiting.
- Move timestamps into due-now conditions when possible.
- Invoke the responsible job or processor deliberately.
- Assert the resulting backend and UI state after deliberate triggering.

### Availability and External Provider State

- Prove the product's user-facing availability contract in the main UI suite.
- UI tests should prove the product contract even if separate integration tests are needed to prove provider synchronization.
- Do not make the main UI suite depend on observing external provider state in real time unless explicitly required.
- Cover provider-side correctness with thinner focused integration checks when needed.

### Multi-User and Concurrency

- Use separate contexts, sessions, and users.
- Simulate interleaved behavior at the critical handoff point.
- Prove final truth is enforced on submit, not only when availability is first shown.

### Evidence

- Keep evidence lean but reviewable.
- Capture screenshots at key checkpoints.
- Keep short videos only when they add debugging value.
- Preserve Playwright trace or report artifacts when available.
- Capture frontend console errors and relevant network failures during the run and preserve them in reviewable artifacts or summaries.
- Work on a copy of the supplied test plan and mark results on that copy.
- Do not invent a large separate reporting process if the marked test plan can remain the primary review artifact.

## Workflow

### 1. Ingest Project Docs

Read only the docs the user provides for the current project, such as:

- frozen scenarios
- acceptance or QA plans
- architecture notes
- environment constraints
- seed-data or reset instructions
- existing test strategy notes

Extract and summarize:

- P0/P1 scenarios that are strong candidates for automation
- scenarios that should remain manual
- every navigation surface that should be smoke-covered first: top nav, footer nav, hamburger/mobile nav, and any other menu form present in the product
- required test hooks, helper utilities, or support endpoints
- required test data and reset requirements
- what browser-error capture is needed for the exercised domains
- blockers, observability gaps, and likely flake risks

Do not start implementing immediately unless the user explicitly skips the approval gate.

### 2. Propose a Lean Scope for Approval

Present a short approval block before implementation. Keep it concrete and reviewable.

Include:

- the required smoke navigation coverage across the site's navigation surfaces
- proposed automated scenarios
- what remains manual
- required assumptions
- required hooks, support endpoints, scripts, or fixtures
- whether test data or environment reset is needed
- how frontend console errors and network failures will be captured and evaluated
- framework choice, defaulting to Playwright
- artifacts and report outputs that will be produced

Separate clearly:

- must automate now
- nice later

If the proposed scope is too broad, shrink it to the smallest set that protects the main business invariants.

The default first slice should be:

1. Smoke navigation across all discovered navigation surfaces.
2. Frontend-runtime cleanliness checks during that navigation.
3. Only then the deeper business-flow scenarios.

### 3. Plan the Implementation

After approval:

- enumerate all links in the nav bar, footer bar, hamburger menu in mobile layout, and any other navigation menu form that exists
- define desktop and mobile viewport coverage where navigation differs
- map each approved scenario to deterministic setup, execution, and assertion steps
- identify where controlled backend support is required
- prefer adding thin helper utilities over brittle UI-only workarounds
- decide what should run as one suite versus targeted specs
- define how the run will reset or isolate state

Prefer direct, business-level scenario names and IDs that match the user's test plan where possible.

The initial smoke plan should verify, at minimum:

- each primary navigation link can be opened from its real navigation surface
- the destination renders without unexpected console or network errors
- mobile-only and desktop-only navigation variants both work when they exist
- obvious broken routes, missing pages, and runtime failures are surfaced before deeper testing begins

### 4. Implement the Automation

Default to Playwright unless the user requests another framework.

Implementation expectations:

- begin with a smoke spec or smoke phase that walks all discovered navigation links first
- keep helpers focused on controlled link retrieval, time control, deliberate job triggering, and stable data setup
- use separate contexts for multi-user flows
- assert final business outcomes, not just transient UI text
- attach listeners for page errors, console errors, and relevant failed network requests
- classify frontend errors by expected vs unexpected; default unexpected errors to failure-worthy
- keep selectors and page objects as light as practical
- add only the abstractions needed to keep the suite readable and maintainable

When a scenario passes functionally but emits unexpected frontend errors or failed network calls, treat that as a bug to be fixed, not a clean pass.

For the navigation smoke pass:

- cover nav bar links
- cover footer links
- cover hamburger-menu links in mobile layout
- cover any alternate menu structure discovered in the app
- fail the smoke pass if any primary navigation destination is broken or runtime-noisy

If the app lacks the hooks needed for deterministic coverage, stop and state exactly what must be added.

### 5. Execute the Run

Run the approved scope against the agreed environment.

During execution:

- run the navigation smoke phase first so obvious broken routes or runtime issues are caught before deeper business scenarios
- collect screenshots at key checkpoints
- retain traces, reports, videos, or logs when useful
- collect console-error, page-error, and failed-request evidence for each exercised domain
- stop on blockers that require human action
- classify failures quickly as product bug, test bug, environment issue, or documentation gap

Do not keep retrying blindly through a flaky or blocked step. Explain the control problem first.

Do not mark a tested domain clean if it still emits unexpected frontend errors by the end of the suite.

### 6. Report Concisely

Return a review-friendly report containing:

1. concise run summary
2. scenario review table or checklist
3. evidence artifact paths
4. failure summaries
5. frontend-error and network-failure summary for the tested domains
6. coverage note for what is now protected and what remains manual

Use the supplied test plan copy as a primary artifact when possible.

## Blocking Rule

If human intervention is needed mid-run:

- stop immediately
- state exactly what blocked execution
- state the minimum action the user must take
- state which scenario or run step is waiting on that action

Avoid vague or repeated questions.

## Output Contract

### Approval Block

Before implementation, provide a compact approval block with:

- smoke navigation scope
- automated scenarios
- manual-only areas
- assumptions
- required hooks
- test data or reset needs
- produced artifacts

### Final Run Summary

At the end, provide:

- whether the navigation smoke pass is clean
- what was automated
- what passed
- what failed
- what was skipped or blocked and why

### Review Table

Include, in a compact table or checklist:

- scenario ID or title
- PASS, FAIL, BLOCKED, or SKIPPED
- one-sentence summary
- evidence path or link
- updated test-plan row or reference when useful
- bug or reference ID when applicable

### Failure Summaries

For each failure, state:

- where it failed
- likely classification: product bug, test bug, environment issue, or documentation gap
- shortest likely explanation
- exact repro summary if known

Treat these as failures or bugs unless explicitly approved otherwise:

- unhandled page errors
- unexpected console errors
- unexpected failed network requests relevant to the exercised flow

### Coverage Note

State:

- what risks are now protected by automation
- what is still manual
- the next highest-value automation increment

Also state whether the tested domains finished clean from a frontend-runtime perspective. If not, list the remaining console or network issues that prevent calling the domain clean.

State separately whether the navigation surfaces are clean across desktop and mobile variants when those variants were in scope.

## Scenario Design Examples

Use these only as examples of sequencing style. Do not hardcode their domain logic.

### Availability Invariant Example

Intent: prove that after a successful booking, a slot is no longer available to another user, and after cancellation it becomes available again.

1. User A opens the booking UI.
2. Select a known available slot.
3. Complete booking successfully.
4. User B opens the booking UI in a fresh context.
5. Verify the same slot is no longer available or selectable.
6. Cancel the booking through the real product flow.
7. Reopen the booking UI in a fresh context.
8. Verify the same slot is available or selectable again.

### Multi-User Race Example

Intent: prove conflict handling when two users compete for the same slot and one submits after the slot has already been taken.

1. User A opens the booking UI.
2. Select slot X and reach the final review step.
3. Pause before final submit.
4. User B opens the booking UI in a separate context.
5. User B books slot X successfully.
6. User A clicks final submit.
7. Verify User A receives a clean business message that the slot was just taken.
8. Verify User A is returned to a state where another option can be chosen.
9. Verify no duplicate booking was created.
