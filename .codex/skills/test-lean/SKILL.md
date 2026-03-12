---
name: test-lean
description: Apply this project's lean pre-launch automated testing policy. Use when Codex adds, updates, reviews, or decides whether to write automated tests for backend work in V1, especially for booking flows, provider boundaries, cron side effects, observability logging, and bug-fix regressions.
---

# Test Lean

Follow a minimal, integration-first testing policy for the pre-launch phase. Optimize for safety on critical backend flows without building a large, brittle suite.

## Non-Negotiable Safety Caveat

Before designing, writing, or running any automated test, enforce all of the following:

- Never use a real payment provider integration for automated tests. Keep all payment transactions, payment attempts, and payment-side effects strictly mock-only. If there is any doubt, or if mock scaffolding does not already exist, stop and ask the user immediately.
- Never read real customer or client data from the database, files, or documents for use in tests. Never send real emails or messages. Never change or delete real customer or business data as part of automated testing.
- Never update or delete existing business data that was not created by the current test run. Unless the user explicitly authorizes otherwise, automated tests must create fresh test data first. Only data created by that same test run may be updated or deleted during cleanup or scenario execution.

## Core Rules

- Prefer a few meaningful tests over many shallow tests.
- Prefer integration tests over unit tests for backend behavior.
- Test real behavior and observable outcomes, not implementation details.
- Use a real test database and clean state between tests.
- Mock only true external providers and SDKs.
- Add a regression test for every bug fix.
- Keep test scaffolding simple. Do not build frameworks for hypothetical future needs.

## Choose the Smallest Useful Test

Default to this order:

1. Integration test for real backend or service behavior.
2. A few real HTTP end-to-end backend tests for critical endpoints.
3. Unit test only for pure logic.
4. Contract test only for external provider payload shape.

If the change is experimental or likely to be refactored soon, postpone tests until the design stabilizes unless the code touches critical business behavior or fixes a bug.

## Write Integration Tests First

Make integration tests the primary layer for backend flows.

Integration tests should:

- run real service logic
- use a real test database connection
- verify observable outcomes such as database rows, state transitions, scheduled side effects, and logs
- avoid mocks for internal services, repositories, business logic, and state transitions

Prefer integration coverage for:

- booking creation
- booking events and side-effect scheduling
- rescheduling
- refunds
- cron execution of side effects
- observability logging behavior

## Keep API End-to-End Coverage Small

Add a small number of tests that call the real HTTP endpoints end to end.

Prioritize critical routes such as:

- `POST /api/bookings`
- `POST /api/bookings/{id}/reschedule`
- `POST /api/bookings/{id}/refund`

Use these tests to verify the full backend pipeline, not to exhaustively cover every branch.

## Limit Unit Tests to Pure Logic

Write unit tests only for logic that is pure, stable, and worth isolating.

Good candidates:

- validation rules
- booking state transitions
- retry logic
- data transformations

Do not write unit tests for thin wrappers, trivial functions, or code whose value only appears when integrated with the real system.

## Use Contract Tests Sparingly

Add contract tests only at external provider boundaries.

Good candidates:

- Google Calendar request structure
- email provider payload format
- payment provider webhook shape

Verify request and response shape without calling the real provider.

## Mocking Policy

Allow mocks only for:

- external APIs
- external services
- provider SDKs

Do not mock:

- database access
- internal services
- repositories
- business logic
- state transitions

If a test needs many mocks, rewrite it as an integration test or drop it.

## Database Policy

- Use a dedicated test database connection.
- Never point tests at production data or production credentials.
- Insert test data as needed.
- Reset state after each test by truncation, transactions, or equivalent isolation.
- Treat test cleanup as mandatory.

## Test Validity Rule

Every automated test must prove it can detect a real failure.

Before keeping a new test, briefly sanity-check it by making the behavior wrong and confirming the test fails. Use the lightest practical check, for example:

- invert the expected result
- remove a key state transition
- temporarily change the implementation branch
- return an incorrect value

If the test still passes, rewrite or delete it.

## What Not to Do in V1

Do not:

- generate large numbers of tests
- introduce UI or browser tests
- enforce strict TDD everywhere
- mock the entire system
- create complex test frameworks
- create snapshot tests
- create coverage-driven suites

## Output Expectations

When finishing work under this policy, state:

- which tests were added and why they are the smallest useful set
- why the chosen test level was appropriate
- what external providers were mocked, if any
- how test database isolation and cleanup are handled
- how each new test was sanity-checked to confirm it can really fail
