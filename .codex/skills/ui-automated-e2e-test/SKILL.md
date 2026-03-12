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
- Prefer strong assertions about business outcomes over page mechanics.
- Prefer deterministic setup, teardown, and data control.
- Use separate browser contexts or sessions for multi-user flows.
- Use helper utilities for controlled link retrieval, deliberate job triggering, and time simulation where needed.
- Avoid hard sleeps unless there is no controlled alternative.
- Avoid abstraction pyramids unless repeated usage clearly justifies them.
- Separate UI product-contract coverage from provider-specific integration checks when sensible.

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
- required test hooks, helper utilities, or support endpoints
- required test data and reset requirements
- blockers, observability gaps, and likely flake risks

Do not start implementing immediately unless the user explicitly skips the approval gate.

### 2. Propose a Lean Scope for Approval

Present a short approval block before implementation. Keep it concrete and reviewable.

Include:

- proposed automated scenarios
- what remains manual
- required assumptions
- required hooks, support endpoints, scripts, or fixtures
- whether test data or environment reset is needed
- framework choice, defaulting to Playwright
- artifacts and report outputs that will be produced

Separate clearly:

- must automate now
- nice later

If the proposed scope is too broad, shrink it to the smallest set that protects the main business invariants.

### 3. Plan the Implementation

After approval:

- map each approved scenario to deterministic setup, execution, and assertion steps
- identify where controlled backend support is required
- prefer adding thin helper utilities over brittle UI-only workarounds
- decide what should run as one suite versus targeted specs
- define how the run will reset or isolate state

Prefer direct, business-level scenario names and IDs that match the user's test plan where possible.

### 4. Implement the Automation

Default to Playwright unless the user requests another framework.

Implementation expectations:

- keep helpers focused on controlled link retrieval, time control, deliberate job triggering, and stable data setup
- use separate contexts for multi-user flows
- assert final business outcomes, not just transient UI text
- keep selectors and page objects as light as practical
- add only the abstractions needed to keep the suite readable and maintainable

If the app lacks the hooks needed for deterministic coverage, stop and state exactly what must be added.

### 5. Execute the Run

Run the approved scope against the agreed environment.

During execution:

- collect screenshots at key checkpoints
- retain traces, reports, videos, or logs when useful
- stop on blockers that require human action
- classify failures quickly as product bug, test bug, environment issue, or documentation gap

Do not keep retrying blindly through a flaky or blocked step. Explain the control problem first.

### 6. Report Concisely

Return a review-friendly report containing:

1. concise run summary
2. scenario review table or checklist
3. evidence artifact paths
4. failure summaries
5. coverage note for what is now protected and what remains manual

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

- automated scenarios
- manual-only areas
- assumptions
- required hooks
- test data or reset needs
- produced artifacts

### Final Run Summary

At the end, provide:

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

### Coverage Note

State:

- what risks are now protected by automation
- what is still manual
- the next highest-value automation increment

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
