# Observability Refactor Policy

## Goal
Replace the current fragmented observability with a minimal, reliable model that supports booking flows, side effects, provider calls, cron execution, and manual debugging before launch.

## Scope Separation

### Business truth
Keep business workflow state in domain tables only:
- `bookings`
- `booking_events`
- `booking_side_effects`
- `booking_side_effect_attempts`

These tables describe business lifecycle and side-effect execution state.

### Technical observability
Use exactly two technical tables:
- `api_logs`
- `exception_logs`

Each row must also include `app_area` identifying the application surface:
- `website`
- `admin`
- `pa`

This allows filtering logs across multiple surfaces sharing the same backend.

No additional observability tables.

## Core Rules
1. Business code does not write logs directly.
2. Only wrappers write to observability tables.
3. Every logged row must have `created_at`.
4. `api_logs` stores one row per technical request.
5. `exception_logs` stores only uncaught / top-level exceptions.
6. Logging must survive partial business failures.
7. Logging must not create excessive Worker subrequests.
8. DB-persisted info chatter is forbidden.

## Identifiers

### `booking_id`
Identifies the business entity.

### `correlation_id`
Identifies one business operation.
Examples:
- booking create
- payment capture
- reschedule
- refund
- side-effect retry
- cron execution unit

A booking can have multiple correlation IDs over time.

### `request_id`
Identifies one execution context.
Examples:
- one inbound HTTP request
- one cron invocation

## Required hierarchy
- `booking_id` = object
- `correlation_id` = operation on object
- `request_id` = one execution of code

## Table Model

### `api_logs`
One row per inbound or outbound request.

Required fields:
- `id`
- `app_area` (`website`, `admin`, `pa`)
- `created_at`
- `completed_at`
- `request_id`
- `correlation_id`
- `booking_id` nullable
- `booking_event_id` nullable
- `side_effect_id` nullable
- `side_effect_attempt_id` nullable
- `direction` (`inbound`, `outbound`)
- `provider` nullable
- `method`
- `url`
- `request_headers_redacted`
- `request_body_preview`
- `response_status`
- `response_headers_redacted`
- `response_body_preview`
- `duration_ms`
- `error_code`
- `error_message`

Rule:
- insert once when request starts
- update same row when response or failure is known

### `exception_logs`
One row per uncaught exception.

Required fields:
- `id`
- `app_area` (`website`, `admin`, `pa`)
- `created_at`
- `request_id`
- `correlation_id`
- `booking_id` nullable
- `booking_event_id` nullable
- `side_effect_id` nullable
- `side_effect_attempt_id` nullable
- `error_type`
- `error_code`
- `message`
- `stack_trace`
- `context_json`

Rule:
- only top-level / unhandled exceptions go here
- handled / translated business failures do not create exception rows unless they escape wrapper boundaries

## Wrapper Architecture

### 1. Inbound route wrapper
All routes go through one shared wrapper.

Responsibilities:
- create `request_id`
- create `correlation_id`
- create inbound `api_logs` row
- sanitize inbound request metadata/body before insert
- execute handler
- update same `api_logs` row with response status/body preview/duration
- catch unhandled errors
- write `exception_logs` row if needed
- return standardized error response

Pseudo flow:
```text
withRouteContext(routeHandler):
  ctx = startOperationContext(...)
  apiLogId = insertApiLog(direction='inbound', sanitized request)
  try:
    result = routeHandler(ctx)
    updateApiLog(apiLogId, sanitized success response)
    return result
  catch err:
    updateApiLog(apiLogId, error fields)
    insertExceptionLog(ctx, err)
    return standardized error response
```

### 2. Outbound provider wrapper
All provider calls go through one shared wrapper.

Examples:
- Google Calendar
- email provider
- payment provider
- WhatsApp provider

Responsibilities:
- receive existing `ctx`
- create outbound `api_logs` row
- sanitize outbound request data before insert
- execute provider call
- sanitize provider response before update
- update same `api_logs` row with response status/body preview/duration
- on error, update same row with error metadata and rethrow typed error
- return the real `api_log_id`

Pseudo flow:
```text
withProviderCall(ctx, callSpec):
  apiLogId = insertApiLog(direction='outbound', sanitized request)
  try:
    providerResponse = callProvider(...)
    updateApiLog(apiLogId, sanitized provider response)
    return { providerResponse, apiLogId }
  catch err:
    updateApiLog(apiLogId, error fields)
    throw translateProviderError(err, apiLogId)
```

## Context Propagation
The outermost entry point creates the context.
All downstream functions receive the same context.

Context shape:
```text
ctx = {
  requestId,
  correlationId,
  bookingId?,
  bookingEventId?,
  sideEffectId?,
  sideEffectAttemptId?
}
```

Rules:
- inner functions do not generate their own `request_id`
- inner functions do not generate their own `correlation_id`
- only a true new operation may create a new `correlation_id`

## Correlation Policy

### Booking-related operations
Use one `correlation_id` per operation, not per booking lifetime.

Examples for same booking:
- Monday create booking -> `corr_A`
- Wednesday capture payment -> `corr_B`
- Thursday reschedule -> `corr_C`
- Friday refund -> `corr_D`

### Cron / retry operations
Cron invocations have their own `request_id`.
Each actual execution unit gets its own `correlation_id` when it starts a distinct operation.
Always attach `booking_id` and side-effect foreign keys when available.

## Sanitization Policy
Sensitive data must be removed in wrappers before any DB write.

Minimum redaction targets:
- `authorization`
- `cookie`
- `set-cookie`
- `token`
- `access_token`
- `refresh_token`
- `client_secret`
- `password`
- card / payment secret fields
- any provider credentials

Storage policy:
- store redacted headers only
- store redacted body previews only
- truncate large payloads
- never store raw secrets

Business-specific code may supply extra redaction rules, but baseline redaction is mandatory in wrappers.

## Error Handling Policy
1. Use one outer try/catch in the shared route wrapper.
2. Provider wrapper catches provider failures, logs them, and rethrows typed errors.
3. Business functions may catch only to translate low-level failures into typed domain errors.
4. Handlers must not swallow errors and return ad hoc generic failures.
5. No fake `api_log_id` values. Only real inserted IDs may be stored.

## Logging Policy
Persist to DB only:
- inbound requests
- outbound provider calls
- meaningful 4xx/5xx failures
- side-effect attempt outcomes
- uncaught exceptions
- optional single cron summary row when meaningful work happened or the sweep failed

Do not persist to DB:
- step-by-step info chatter
- repository noise
- debug spam
- duplicate “about to do X / finished X” rows

## Performance Policy
Observability must not dominate Worker subrequests.

Required changes:
- remove fragmented multi-table observability writes
- remove DB-persisted info-level cron logging
- remove recursive logging of logging failures
- keep one insert + one update per technical request row

## Migration Constraints
1. Replace old observability usage with wrappers.
2. Remove direct writes to legacy observability tables.
3. Any field like `booking_side_effect_attempts.api_log_id` must reference a real `api_logs.id` or be `NULL`.
4. No generated placeholder UUIDs for observability FKs.

## 10 Commandments for the Vibe Coder
1. Keep business state in booking tables; do not turn `api_logs` into business history.
2. Use exactly two observability tables: `api_logs` and `exception_logs`.
3. Route all inbound requests through one shared route wrapper.
4. Route all outbound provider calls through one shared provider wrapper.
5. Sanitize request/response data in wrappers before writing anything to DB.
6. Generate `request_id` once per execution and propagate it through context.
7. Generate `correlation_id` once per business operation and propagate it through context.
8. Never let business code insert logs directly or invent fake `api_log_id` values.
9. Persist only meaningful technical events; ban DB log spam.
10. Prefer boring, reliable, traceable code over clever observability abstractions.

## Final CTA Prompt
Refactor the codebase to implement this policy exactly.

Required output:
1. introduce the two shared wrappers (`withRouteContext`, `withProviderCall`)
2. replace fragmented observability usage with wrapper-based logging
3. migrate all relevant handlers and providers to use propagated context
4. ensure sanitization occurs before every observability DB write
5. ensure all `api_log_id` references point to real `api_logs.id` rows only
6. remove DB-persisted info chatter and legacy observability patchwork
7. keep the implementation KISS, DRY, and easy to debug manually

Do not add new abstraction layers unless they are strictly necessary to implement the above.
