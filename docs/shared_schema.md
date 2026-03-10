# Shared Observability Schema

## Why this exists

This repo now uses a shared, server-written observability model for:

- the marketing site frontend
- the booking Worker backend
- the PA frontend
- the PA API backend

The goal is short-term debugging and flow validation, not full APM. Logs are structured, compact, and intentionally easy to prune.

## Why the schema is `observability`

These tables live in the custom Postgres schema `observability` instead of `public`, `auth`, or `vault` because:

- `public` is exposed by default through Supabase data APIs and is the wrong default for internal debug data
- `auth` and `vault` are managed Supabase schemas and should not be repurposed
- `observability` makes the intent explicit and keeps retention/admin work isolated

The backend writes through the service role. Anonymous/browser clients do not write to the database directly.

Supabase note:

- because the app writes through the REST API client, the custom schema must be added to Supabase's exposed schemas list
- exposure alone does not make it public; RLS and service-role-only access still keep it server-side in practice

## Tables

### `observability.logs`

The generic base event table.

Use it for:

- inbound request summaries
- uncaught and handled exceptions
- temporary business-flow milestones
- generic structured info/warn/error events

Important columns:

- `source`: `frontend`, `backend`, `worker`, `cron`, or `provider`
- `level`: `debug`, `info`, `warn`, `error`, `fatal`
- `event_type`: examples include `request`, `request_failure`, `provider_call`, `provider_failure`, `flow_milestone`, `uncaught_exception`
- `request_id` and `correlation_id`: for tracing a single request or a full flow
- `context`: compact structured metadata

### `observability.api_logs`

The lean HTTP/provider lifecycle table.

Use it for:

- inbound API request summaries
- outbound provider/API request summaries

It stores method, URL/path, status, duration, success flag, retry count, and size metadata. It does not store bulky payloads.

### `observability.api_failure_details`

Failure-only or explicitly sampled deep-debug payload previews.

Use it for:

- redacted request/response previews on provider failures
- stack traces or provider error text for failed outbound calls

Rules:

- secrets are redacted before insert
- large bodies are truncated
- binary content is skipped
- size metadata belongs in `api_logs`

### `observability.error_details`

Runtime exception metadata for frontend/backend/worker failures.

Use it for:

- stack traces
- component/runtime/browser info
- file/line/column when available
- small extra structured metadata

### Booking retry state

Durable workflow retry state is tracked by:

- `booking_side_effects` (intended action + lifecycle status)
- `booking_side_effect_attempts` (attempt-by-attempt execution results)

There is intentionally no `job_runs` table. Cron/manual job execution is traced through structured events in `observability.logs`, while durable retry state lives in booking side-effect tables.

## Technical logs vs business milestone logs

These are different and both matter.

- Technical/API logs answer: did the request to OpenAI, Google TTS, Turnstile, Resend, or the app API succeed technically?
- Business milestone logs answer: did the actual workflow state transition happen in our system?

Example:

- Stripe or checkout transport can succeed
- but the booking may still fail to move to the expected internal state

That is why milestone events live in `observability.logs` with `event_type = 'flow_milestone'`.

Current examples include:

- `checkout_started`
- `booking_created`
- `booking_confirmed`
- `confirmation_email_requested`
- `confirmation_email_sent`
- `payment_confirmed`
- `provider_result_persisted`
- `fallback_triggered`

These milestone logs are intentionally temporary debug instrumentation. They should be reduced once the flow is stable in production.

## Redaction rules

The logger strips or masks keys like:

- `authorization`
- `cookie`
- `set-cookie`
- `x-api-key`
- `api_key`
- `token`
- `password`
- `secret`
- `access_token`
- `refresh_token`
- `client_secret`
- `assertion`
- `signature`

Additional behavior:

- full browser URLs are not logged; browser events use path-only routes
- client-supplied frontend routes are sanitized again on the server before persistence
- URL query strings and form-encoded bodies are redacted before persistence
- large text bodies are truncated to previews
- nested payloads are depth-limited
- binary data is omitted
- browser-side logging never writes directly to Supabase

## Retention policy

The schema is optimized for cleanup.

- general logs: keep about 30 days
- failure/error detail rows: effectively follow base-log retention unless the FK model is changed

Current implementation note:

- detail rows cascade from base rows, so the default cleanup keeps both at about 30 days
- if longer-lived detail retention is needed later, the schema relationship must change first

Migration helper:

```sql
select observability.cleanup_retention();
```

You can override the windows if needed:

```sql
select observability.cleanup_retention(interval '30 days', interval '30 days');
```

## How the logs relate across frontend, backend, and providers

The common shape is:

1. frontend creates or forwards a `request_id`
2. frontend starts a fresh `correlation_id` for each meaningful workflow/action
3. backend/worker preserves or generates them
4. inbound request summaries land in `observability.logs` + `observability.api_logs`
5. outbound provider calls land in the same base table plus provider-facing `api_logs`
6. failures add `api_failure_details` or `error_details`
7. business milestones and cron/job summaries reuse `observability.logs`
8. durable retry and failure state lives in `booking_side_effects` + `booking_side_effect_attempts`

This keeps one traceable chain per workflow without forcing every event into the same wide table.

## Common queries

Trace a workflow by correlation ID:

```sql
select created_at, source, level, event_type, message, context
from observability.logs
where correlation_id = 'your-correlation-id'
order by created_at asc;
```

Trace provider failures for one workflow:

```sql
select
  l.created_at,
  l.correlation_id,
  al.provider,
  al.method,
  al.path,
  al.status_code,
  afd.provider_error
from observability.logs l
join observability.api_logs al on al.log_id = l.id
left join observability.api_failure_details afd on afd.api_log_id = al.id
where l.correlation_id = 'your-correlation-id'
order by l.created_at asc;
```

Find recent uncaught frontend errors:

```sql
select l.created_at, l.route, l.message, ed.error_name, ed.file, ed.line_number
from observability.logs l
join observability.error_details ed on ed.log_id = l.id
where l.source = 'frontend'
  and l.event_type = 'uncaught_exception'
order by l.created_at desc
limit 50;
```

Trace a booking by booking ID stored in milestone context:

```sql
select created_at, event_type, message, context
from observability.logs
where context ->> 'booking_id' = 'your-booking-id'
order by created_at asc;
```

Trace a registration by registration ID:

```sql
select created_at, event_type, message, context
from observability.logs
where context ->> 'booking_id' = 'your-booking-id'
order by created_at asc;
```

Compare transport success vs workflow success:

```sql
select created_at, source, event_type, message, context
from observability.logs
where correlation_id = 'your-correlation-id'
  and event_type in ('provider_call', 'provider_failure', 'flow_milestone')
order by created_at asc;
```

## Where wrappers are attached

Current attachment points:

- `apps/api-booking/src/index.ts`: top-level booking/admin worker fetch and cron wrappers
- `apps/api-booking/src/router.ts`: inbound request summary logging and uncaught route errors
- `apps/api-booking/src/services/booking-service.ts`: booking and event business milestones
- `apps/api-pa/src/index.ts`: top-level PA Hono middleware and frontend log ingestion
- `apps/api-pa/src/llm/parse.ts`: outbound OpenAI parse/refine instrumentation
- `apps/api-pa/src/llm/translate.ts`: outbound OpenAI translation instrumentation
- `apps/site/js/main.js`: global browser error and rejection handlers
- `apps/site/js/api.js`: frontend API request instrumentation
- `apps/pa/src/main.tsx`: global browser error and rejection handlers
- `apps/pa/src/ui/ErrorBoundary.tsx`: React route/app boundary
- `apps/pa/src/api.ts`: frontend API request instrumentation

## When to remove temporary milestone logs

Remove or reduce milestone logs when:

- the flow has been stable in production for a meaningful period
- correlation-based debugging is no longer needed for that path
- failures can already be diagnosed from request/error/provider logs alone

Keep milestones only for true state transitions. Do not leave noisy intermediate logs in place indefinitely.
