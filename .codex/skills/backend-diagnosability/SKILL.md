---
name: backend-diagnosability
description: Enforce diagnosable backend changes with structured logging, explicit branch and failure reasons, consistent error envelopes, and tests for both behavior and diagnostics. Use when Codex implements or reviews backend endpoints, auth checks, permission gates, feature flags, external integrations, non-trivial branching, or debugging work where runtime path clarity matters.
---

# Backend Diagnosability

Build backend changes so operators can reconstruct the exact runtime path from logs and tests. Prefer explicit decision logging and stable failure envelopes over terse handlers that only surface a status code.

## Workflow

1. Identify the decision points.
2. Add logs before changing behavior.
3. Normalize failure responses.
4. Implement the functional fix or feature.
5. Add tests for behavior and diagnostics.
6. Report required runtime configuration and environment.

## Identify Decision Points

Treat each of these as a mandatory instrumentation boundary:

- Endpoint entry and exit.
- Auth checks.
- Permission gates.
- Feature flag evaluation.
- External API or service integration.
- Any non-trivial branch with different outcomes.
- Top-level exception handling.

When reading an existing handler, map the concrete branches first: allowed, denied, disabled, validation failure, conflict, dependency failure, and unexpected error.

## Add Logs Before Changing Behavior

Add structured logs immediately before and after each decision point. Use field-based logs, not prose-only strings.

Always capture:

- Stable event name.
- Request or operation identifier if available.
- Branch being evaluated or taken.
- Relevant config or feature-flag values.
- Actor or subject identifiers when safe.
- Concrete deny or failure reason.
- External dependency name and outcome when relevant.

Prefer a shape like:

```ts
logger.info("booking.upload.auth_check.start", {
  requestId,
  userId,
  route: "/upload",
});

logger.warn("booking.upload.auth_check.denied", {
  requestId,
  userId,
  branch: "missing_session",
  denyReason: "session_cookie_absent",
});
```

After the branch resolves, emit a second log with the exact path taken:

```ts
logger.info("booking.upload.auth_check.result", {
  requestId,
  branch: "authorized",
  authMode: env.AUTH_MODE,
});
```

For debugging an existing issue, add temporary logs first, confirm the failing branch and runtime values, then implement the fix. Tell the user which variables or config values must be present and in which environment they matter.

## Normalize Failure Responses

Every `401`, `403`, `404`, `409`, `422`, `500`, and top-level handler failure must preserve the same response envelope used by that backend. Do not introduce one-off JSON shapes for individual branches.

Ensure error responses also:

- Include CORS headers where the backend expects them.
- Carry a concrete machine-usable reason field or equivalent envelope payload.
- Match the same content type and envelope wrapper as success/failure conventions elsewhere in the service.

Avoid vague outcomes such as `"Unauthorized"` or `"Forbidden"` when the system can provide the real branch reason, for example `missing_api_key`, `feature_disabled`, `role_mismatch`, `invalid_payload`, or `upstream_timeout`.

## Implement the Change

Once logs and response shape are clear, implement the endpoint or fix. Preserve existing observability helpers where possible instead of inventing competing patterns.

If the codebase already has:

- A shared logger helper, use it.
- An error response builder, route all failure branches through it.
- Request-context middleware, pull request IDs and actor metadata from there.

If these helpers are missing and the task adds meaningful backend logic, add the smallest reusable helper that improves consistency.

## Test Diagnostics, Not Just Behavior

Add or update tests for both the user-visible result and the diagnostic path.

Cover important failure modes:

- Auth denied.
- Permission denied.
- Feature disabled.
- Validation failure.
- External dependency failure.
- Unexpected exception path.

Verify at least:

- Status code and response envelope.
- CORS headers when applicable.
- Logged event names.
- Logged branch value.
- Logged deny or failure reason.
- Relevant config or flag state when that controls the branch.

If the test stack supports log capture, assert on structured fields rather than raw string fragments.

## Output Expectations

When finishing a task with this skill, report:

- What branches were instrumented.
- What failure envelope path was preserved or introduced.
- What tests were added or updated.
- Which runtime variables, feature flags, secrets, or environment-specific settings are required.
- Which temporary logs were added and whether they should remain or be removed after verification.
