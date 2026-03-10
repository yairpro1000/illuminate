# calendar_integration.md

## 1. OAuth Flow

-   Google Cloud project with Calendar API enabled.
-   OAuth Web Application credentials.
-   Refresh token stored securely server-side.

------------------------------------------------------------------------

## 2. Token Storage

-   Access tokens never stored in client.
-   Refresh token stored in environment or secure DB table.
-   Token refresh handled server-side.

------------------------------------------------------------------------

## 3. Slot Calculation Logic

-   Query calendar for busy events.
-   Generate available slots within working hours.
-   Exclude bookings in pending states where slot reserved.

------------------------------------------------------------------------

## 4. Event Creation Logic

On booking confirmation: - Create Google Calendar event. - Store
`google_event_id` in booking.

On cancellation: - Delete or update calendar event.

------------------------------------------------------------------------

## 5. Reschedule Update Logic

-   Update existing Google event using stored `google_event_id`.
-   Maintain idempotency in case of retry.

------------------------------------------------------------------------

## 6. Automatic Failure Recovery

-   Calendar write failures (`create`, `update`, `delete`) are persisted in `failure_logs` with:
    - `source = 'calendar'`
    - `operation = 'calendar_sync'`
    - `booking_id`
    - `attempts`
    - `next_retry_at`
    - `error_message` (latest error)
    - `resolved_at`
    - operation type in `context.calendar_operation`
-   Retries are processed by scheduled Worker job `calendar-sync-retries` inside the unified cron sweep (dispatched every minute).
-   Cron execution itself is traced through structured events in `observability.logs`; no separate `job_runs` table is used.
-   Retry behavior is bounded (max 5 attempts). After exhaustion:
    - record remains persistent for manual intervention
    - `status` is set to `ignored`
    - `retryable = false`
-   On successful retry, record is resolved:
    - `status = 'resolved'`
    - `resolved_at` is set
    - `next_retry_at` cleared
-   `bookings.google_event_id` is written only after successful event creation.

### Operator inspection

Use SQL to inspect unresolved calendar sync issues:

```sql
select
  id,
  booking_id,
  status,
  retryable,
  attempts,
  next_retry_at,
  resolved_at,
  error_message,
  context ->> 'calendar_operation' as calendar_operation
from failure_logs
where source = 'calendar'
  and operation = 'calendar_sync'
  and resolved_at is null
order by updated_at desc;
```

Manual retry trigger (if needed):

```bash
curl -X POST "https://letsilluminate.co/api/jobs/calendar-sync-retries" \
  -H "Authorization: Bearer $JOB_SECRET"
```
