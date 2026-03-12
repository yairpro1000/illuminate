---
name: refactor-observability-and-booking
description: Enforce the staged replacement refactor workflow for this project's observability foundation and booking-domain model. Use when Codex must plan, review, or implement a major refactor touching observability wrappers, `api_logs`, `exception_logs`, booking schema/value sets, booking orchestration, sweeper behavior, provider boundaries, or final cleanup/verification across those areas, and must do the work in strict sequence instead of a mixed all-at-once rewrite.
---

# Refactor Observability And Booking

Load and follow [`refactor`](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/refactor/SKILL.md) first. Treat its execution order, user-interaction rules, and prerequisite use of [`freeze-expected-results`](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/freeze-expected-results/SKILL.md) and [`test-lean`](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/test-lean/SKILL.md) as mandatory, not optional.

When the work touches backend endpoints, wrappers, provider calls, cron handlers, permission checks, or non-trivial branching, also load [`backend-diagnosability`](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/backend-diagnosability/SKILL.md) and enforce its structured logging and error-envelope rules.

This skill exists to keep a large replacement refactor under control. It forbids mega-prompts, hybrid old/new architecture, compatibility theater, and micro-sliced drift. Favor deletion over adaptation.

## Required Inputs

Read [`references/source-artifacts.md`](./references/source-artifacts.md) first, then load only the phase-specific source documents needed for the active phase.

Before implementation, follow the `refactor` prerequisite flow:

1. Ask for the relevant frozen expected-results file path.
2. Read it.
3. Compare the target refactor against the frozen behavior.
4. Report contradictions, missing target details, and deliberate product changes before coding.

If the freeze artifact is missing, stale, or incomplete for the requested scope, stop and tell the user exactly what artifact is needed before proceeding.

## Operating Rules

Classify this work as a large-scale reshaping refactor.

Apply these rules throughout:

- Treat this as replacement refactor work, not transitional migration work.
- Do not preserve legacy compatibility without an explicit user order.
- Do not keep dual old/new wrappers, dual enums, dual schemas, or dual orchestration paths alive.
- Do not redesign observability and booking-domain logic at the same time in one blurred step.
- Do not split the work into tiny unrelated crumbs that lose architectural coherence.
- Prefer architectural layers as the unit of work.
- Make scope boundaries explicit for every phase: in scope, out of scope, deletions, deliverables, and verification.

State this sentence explicitly when relevant: `This is a replacement refactor, not a transitional migration. Favor deletion over compatibility.`

## Sequence

Use four phases. The first three are the architectural sequence. The fourth is the lean test refinement pass after the structure has stabilized.

### Phase 1: Execution And Observability Foundation

Load:

- [`docs/observability_refactor_policy.md`](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/observability_refactor_policy.md)
- current wrapper, route, provider, cron, logging, and error-envelope code in the active scope

Objective:

- build the new execution shape first
- establish one inbound wrapper and one outbound provider wrapper
- establish `api_logs` and `exception_logs` as the only technical observability tables
- unify try/catch and standardized top-level failure handling
- make context propagation clean for downstream business logic

In scope:

- wrapper architecture
- request/context creation and propagation
- sanitization and redaction policy
- logging table writes
- exception capture
- provider boundary behavior
- CORS-safe consistent error envelopes
- removal of fragmented logging paths

Do not do yet:

- do not redesign the booking-domain vocabulary
- do not rework business-state semantics beyond the minimum needed to fit the wrappers
- do not start broad booking-flow cleanup

Deliverables:

- the target observability architecture is installed or clearly staged
- old fragmented observability tables and patchwork logging paths are identified for deletion or removed
- every active route/provider path in scope clearly goes through the shared wrappers
- business code can receive and pass context without generating its own IDs

### Phase 2: Booking Domain And Schema Refactor

Load:

- [`docs/booking_domain_refactor_spec.md`](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/booking_domain_refactor_spec.md)
- [`docs/booking_schema_comanion_2026-03-12.md`](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/booking_schema_comanion_2026-03-12.md)
- [`apps/api-booking/migrations/017_bookings_model_2026-03-12.sql`](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/apps/api-booking/migrations/017_bookings_model_2026-03-12.sql)

Objective:

- build the booking model directly on top of the new execution/observability foundation
- make the spec and orchestration matrix the truth source

In scope:

- booking schema, enums, checks, statuses, and naming
- TypeScript types, validators, constants, and repository mappings
- event-to-side-effect policy
- service/orchestration flow
- sweeper behavior for due verification side effects
- attachment of business entities to the propagated observability context

Do not do yet:

- do not redesign observability again
- do not leave compatibility aliases for old event names, sources, intents, or status values unless the user explicitly orders it
- do not keep old/new business models mixed together

Deliverables:

- the domain vocabulary matches the spec
- old mixed concepts are removed
- service/repo/handler flow aligns with the final model
- verification side effects reuse one pending row and use `expires_at` as the next checkpoint

### Phase 3: Cleanup And Verification Sweep

Load only the source documents needed to verify the active scope plus the current codebase state.

Objective:

- remove leftovers
- prove the replacement architecture is actually the only active architecture

Required checks:

- remove dead code, dead enums, dead wrappers, dead tables, and legacy names
- grep for forbidden legacy patterns
- verify every endpoint in scope uses the shared inbound wrapper
- verify every provider call in scope uses the shared outbound wrapper
- verify correlation linking across request, operation, booking, event, side-effect, and attempt levels
- verify no fragmented observability path survived accidentally
- verify no hybrid business-model path survived accidentally

### Phase 4: Lean Test Refinement

Follow `test-lean` strictly.

Add or refine the smallest useful automated tests after the structure stabilizes. Prefer integration coverage for:

- observability wrappers
- logging/error-envelope behavior
- booking orchestration and state transitions
- side-effect scheduling and attempts
- sweeper behavior
- provider-boundary failure translation

Also verify the logging/diagnostic path for important failure modes when backend diagnosability rules apply.

## Required Interaction Pattern

Before each phase, state:

- which phase is active
- which prerequisite artifacts were read
- what frozen expected results apply
- where the target differs from the frozen baseline
- exact in-scope items
- exact out-of-scope items
- what will be deleted, replaced, preserved, or deferred
- the concrete deliverables for that phase

If the user has not yet provided enough target detail for the active phase, stop and ask only for the missing detail needed to proceed.

## Review Standard

Reject the result if any of these remain true:

- observability is still fragmented
- wrappers are still optional
- business code still writes technical logs directly
- old and new booking vocabularies both remain alive
- cron is still acting like a business source
- fake events or duplicate verification rows remain
- cleanup was skipped because the main path "already works"
- tests are broad but low-signal instead of lean and critical

## Output Expectations

When using this skill, always make the workflow visible and concise. Report:

- that `refactor` was loaded first
- which supporting skills were also loaded
- which source-of-truth documents were read for the active phase
- whether the work is blocked on a freeze artifact or missing spec detail
- what architectural layer is being changed now
- what is explicitly deferred to the next phase
- what deletion or simplification is required
