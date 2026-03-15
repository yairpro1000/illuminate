---
name: test-clean-sweeper
description: Safely clean test bookings and related client rows by shared prefix in this repository. Use when a user wants a two-stage cleanup flow that must first inspect and report booking counts, ask for confirmation, cancel matching bookings, report the result, then inspect and report per-table row counts for deletion, ask for confirmation again, and only then delete the matching client data.
---

# Test Clean Sweeper

Use this skill for safe manual cleanup of test data by client or email prefix.

Keep the workflow strict:

- Never execute a step before reporting the inspection result for that step.
- Never reuse an old confirmation. Ask again before each execution step.
- Never run the delete step before the cancel step has been reported back.

## Runtime Requirements

State the active runtime before running anything:

- Cancel utility:
  - File: `apps/api-booking/scripts/cancel-bookings-by-client-prefix.mjs`
  - Needs `API_BASE_URL` in the current shell or `--api-base-url=<url>`.
  - Default base URL is `http://127.0.0.1:8787` if nothing is provided.
  - The target API must expose `GET /api/__test/bookings` and `POST /api/__test/bookings/cleanup`.

- Delete utility:
  - File: `apps/api-booking/scripts/delete-client-prefix.mjs`
  - Needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the current shell.

If a required variable or target is missing, stop and report exactly what is missing.

## Workflow

### 1. Inspect Bookings To Cancel

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

### 2. Execute Booking Cancellation

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

### 3. Inspect Rows To Delete

After the cancellation result has been reported, run:

```bash
node ./scripts/delete-client-prefix.mjs --email-prefix=<prefix>
```

Report back:

- The exact prefix used.
- `matched_client_count`
- `matched_booking_count`
- `matched_payment_count`
- `matched_contact_message_count`
- `matched_event_reminder_subscription_count`
- A flat per-table summary for `clients`, `bookings`, `payments`, `contact_messages`, and `event_reminder_subscriptions`

Then ask one direct confirmation question. Example:

`Delete these rows for prefix <prefix>?`

### 4. Execute Row Deletion

Only after explicit confirmation, run:

```bash
node ./scripts/delete-client-prefix.mjs --email-prefix=<prefix> --execute
```

Report back:

- The final `deleted_counts` per table.
- Any mismatch, failure, or unexpected zero count.

## Output Discipline

- Keep the user-facing report short and concrete.
- Use exact counts from the utility outputs, not estimates.
- Do not dump raw JSON unless the user asks for it.
- If a command fails, report the failing step, the command intent, and the concrete runtime or config issue.
