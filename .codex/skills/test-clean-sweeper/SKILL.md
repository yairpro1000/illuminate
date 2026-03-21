---
name: test-clean-sweeper
description: Safely clean bookings and related client rows in this repository starting from either shared prefixes or explicit booking IDs. Use when a user wants a two-stage cleanup flow that must first inspect and report booking counts, ask for confirmation, cancel matching bookings through a supported path, report the result, then inspect and report per-table row counts for deletion, ask for confirmation again, and only then delete the matching client data.
---

# Test Clean Sweeper

Use this skill for safe manual cleanup of bookings and related client data starting from either:

- a shared client or email prefix, or
- an explicit list of booking IDs

Default to the supported path that is already proven to work in this repo. Do not force the user back onto a prefix-only path when they gave booking IDs.

Use low freedom. This skill is an execution runbook, not a brainstorming guide.

Keep the workflow strict:

- Never execute a step before reporting the inspection result for that step.
- Never reuse an old confirmation. Ask again before each execution step.
- Never run the delete step before the cancel step has been reported back.
- Never widen deletion scope silently. If booking IDs map to prefixes that include additional rows beyond the explicitly listed bookings, report that clearly before deletion.

## Runtime Requirements

State the active runtime before running anything:

- Prefix-based cancel utility:
  - File: `apps/api-booking/scripts/cancel-bookings-by-client-prefix.mjs`
  - Needs `API_BASE_URL` in the current shell or `--api-base-url=<url>`.
  - Default base URL is `http://127.0.0.1:8787` if nothing is provided.
  - The target API must expose `GET /api/__test/bookings` and `POST /api/__test/bookings/cleanup`.
  - Only use this path when the user started from a prefix and the target API is intentionally exposing the test cleanup endpoints.

- Booking-ID cancellation path:
  - Preferred when the user provides booking IDs directly.
  - Use the supported live API flow:
    1. `POST /api/admin/bookings/:bookingId/manage-link`
    2. extract `token` and `admin_token` from the returned URL
    3. `POST /api/bookings/cancel` with `{ token, admin_token }`
  - Default live base URL: `https://api.letsilluminate.co`
  - This path cancels through the normal booking service and supports admin bypass safely.
  - Prefer this path over inventing direct DB mutations or trying to force booking IDs into the prefix cleanup script.
  - Prefer this path even if `API_BASE_URL` is unset. Do not block on missing local test-endpoint configuration when the user gave booking IDs.

- Delete utility:
  - File: `apps/api-booking/scripts/delete-client-prefix.mjs`
  - Needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the current shell.
  - This utility is prefix-based. If the user starts with booking IDs, first resolve those bookings to client emails and derive the exact email-local-part prefixes to inspect for deletion.
  - From `apps/api-booking`, the root env file is loaded with:

```bash
source ../../.env
```

If a required variable or target is missing, stop and report exactly what is missing.

If network access is blocked in the sandbox but the task requires live API or Supabase calls, immediately request the needed elevated execution instead of repeatedly retrying broken local paths.

## Proven Defaults

Start with these defaults unless the user explicitly says otherwise:

- For booking-ID cancellation:
  - API base URL: `https://api.letsilluminate.co`
  - cancellation mechanism: admin manage-link -> public cancel endpoint
- For deletion inspection and execution:
  - working directory: `apps/api-booking`
  - env load: `source ../../.env`
  - utility: `scripts/delete-client-prefix.mjs`

Do not spend time trying to make the prefix cancel script accept booking IDs. That is the wrong tool for that input.

## Failure To Solution Map

Apply these fixes immediately when the matching failure appears:

- Problem: user provided booking IDs, not prefixes
  - Solution: resolve booking IDs to status and client email, cancel by booking ID through admin manage-link flow, then derive prefixes only for deletion

- Problem: `API_BASE_URL` is unset
  - Solution: for booking IDs, skip the prefix cancel script and use `https://api.letsilluminate.co`

- Problem: local prefix cleanup endpoints are unavailable or irrelevant
  - Solution: use the live admin manage-link cancellation path instead of forcing local `__test` routes

- Problem: sandbox network blocks DNS, `fetch failed`, or `Could not resolve host`
  - Solution: request elevated execution immediately for the live API or Supabase command

- Problem: ad hoc DB inspection fails because of guessed schema columns
  - Solution: switch to the repository's supported utility for the target operation instead of inventing one-off queries

- Problem: Node one-off script cannot find `.env`
  - Solution: run from `apps/api-booking` and load `../../.env`

- Problem: Node one-off script cannot resolve local package paths cleanly
  - Solution: run from `apps/api-booking` and import package names normally

- Problem: deletion utility is prefix-based but the input was booking IDs
  - Solution: derive exact email-local-part prefixes from the resolved client emails, inspect each prefix separately, warn if scope is wider than the original booking list, then ask for delete confirmation

## Input Normalization

Classify the user input first:

- If they provide `--email-prefix`, `--prefix`, or a plain-language prefix request, use the prefix workflow directly.
- If they provide booking IDs, use the booking-ID cancellation workflow first.
- If they provide both, prefer the explicit booking IDs for cancellation and use prefixes only for the later deletion inspection.

When starting from booking IDs:

1. Resolve each booking ID to:
   - existence
   - current status
   - client email
   - start time if available
2. Report the exact resolved set before cancellation.
3. Derive deletion prefixes from the email local part before `@`.
4. Deduplicate those prefixes.
5. Warn clearly if any derived prefix would delete more rows than the original booking-ID list implies.
6. Prefer exact client email local parts such as `name` from `name@example.com`, not partial guessed fragments.

## Workflow

### 1. Inspect What Will Be Canceled

#### A. If starting from prefix

Run from `apps/api-booking`:

```bash
node ./scripts/cancel-bookings-by-client-prefix.mjs --email-prefix=<prefix> [--api-base-url=<url>] [--limit=<n>]
```

Report back:

- The exact prefix used.
- The exact API base URL used.
- The matched booking count.
- A concise list of matched bookings if available from the utility output.

Then ask one direct confirmation question. Example:

`Cancel these <count> bookings for prefix <prefix>?`

If the inspection result is zero, report zero and do not execute unless the user explicitly still wants the run.

#### B. If starting from booking IDs

Do not fail just because the prefix utility does not accept IDs.

Resolve the IDs first using the supported runtime already available in the workspace, typically via live Supabase lookup or equivalent repository-backed inspection.

Preferred approach:

1. Load root env from `apps/api-booking` with:

```bash
source ../../.env
```

2. Query the real data source to map booking IDs to:
   - current status
   - client email
   - start time

3. If sandbox networking blocks the inspection, request elevated execution immediately.

Report back:

- The exact booking IDs requested.
- How many were found.
- Their current statuses.
- The resolved client emails.
- The active runtime you will use for cancellation, normally `https://api.letsilluminate.co`.

Then ask one direct confirmation question. Example:

`Cancel these <count> bookings by booking ID?`

If any booking IDs are missing, say so explicitly before asking.

### 2. Execute Booking Cancellation

#### A. If starting from prefix

Only after explicit confirmation, run:

```bash
node ./scripts/cancel-bookings-by-client-prefix.mjs --email-prefix=<prefix> [--api-base-url=<url>] [--limit=<n>] --execute
```

Report back:

- `matched_count`
- `active_matched_count`
- `processed_count`
- `remaining_active_count`
- `canceled_count`
- `skipped_count`
- `failed_count`
- Any canceled, skipped, or failed booking identifiers returned by the utility

If any failures are returned, say so explicitly before continuing.

#### B. If starting from booking IDs

Only after explicit confirmation, cancel each booking through the supported admin manage-link flow:

1. `POST /api/admin/bookings/:bookingId/manage-link`
2. parse `token` and `admin_token` from the returned `url`
3. `POST /api/bookings/cancel`

Preferred execution shape:

1. Use `https://api.letsilluminate.co`
2. Use `curl` or another simple HTTP client when sandboxed `fetch` is unreliable
3. If DNS or networking fails in sandbox, rerun with elevated execution instead of trying alternate broken local paths

Report back:

- `requested_count`
- `processed_count`
- `canceled_count`
- `failed_count`
- every canceled booking ID
- every failed booking ID with the failing stage
- any special result codes such as `CANCELED_AND_REFUNDED`

If the sandbox cannot reach the live host or Supabase, request elevated access immediately and continue through the same supported flow.

### 3. Inspect Rows To Delete

After the cancellation result has been reported, run:

```bash
node ./scripts/delete-client-prefix.mjs --email-prefix=<prefix>
```

If the task started from booking IDs, first derive the exact prefixes from the resolved client emails, then inspect each prefix separately with the same utility.

Preferred execution shape from `apps/api-booking`:

```bash
source ../../.env
node ./scripts/delete-client-prefix.mjs --email-prefix=<prefix>
```

Report back:

- The exact prefix or prefixes used.
- `matched_client_count`
- `matched_booking_count`
- `matched_payment_count`
- `matched_contact_message_count`
- `matched_event_reminder_subscription_count`
- A flat per-table summary for `clients`, `bookings`, `payments`, `contact_messages`, and `event_reminder_subscriptions`
- A clear warning when a prefix matches more bookings or rows than the original booking-ID set

Then ask one direct confirmation question. Example:

`Delete these rows for prefix <prefix>?`

If there are multiple derived prefixes, ask for one confirmation covering the full explicit list.

If any prefix clearly includes extra real rows beyond the originally listed bookings, call that out plainly before asking for confirmation.

### 4. Execute Row Deletion

Only after explicit confirmation, run:

```bash
node ./scripts/delete-client-prefix.mjs --email-prefix=<prefix> --execute
```

If there are multiple derived prefixes, run the delete utility once per exact prefix and aggregate the results.

Preferred execution shape from `apps/api-booking`:

```bash
source ../../.env
node ./scripts/delete-client-prefix.mjs --email-prefix=<prefix> --execute
```

Report back:

- The final `deleted_counts` per table for each prefix.
- Any mismatch, failure, or unexpected zero count.

## Output Discipline

- Keep the user-facing report short and concrete.
- Use exact counts from the utility outputs, not estimates.
- Do not dump raw JSON unless the user asks for it.
- If a command fails, report the failing step, the command intent, and the concrete runtime or config issue.
- Start with the supported working path first:
  - booking IDs -> live admin manage-link cancellation -> derive prefixes -> prefix delete inspection/execution
  - prefix input -> prefix inspect/cancel -> prefix delete inspection/execution
- Do not waste time repeatedly retrying a path that is structurally incompatible with the input shape.
- Do not improvise direct database mutations for cancellation.
- Do not hide widened delete scope. Say it explicitly before the delete confirmation.
