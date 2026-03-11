# calendar_integration.md

## 1. Google Auth Mode

-   Calendar writes use a Google **OAuth refresh-token** flow.
-   Required env vars:
    - `GOOGLE_CLIENT_CALENDAR`
    - `GOOGLE_CLIENT_SECRET_CALENDAR`
    - `GOOGLE_REFRESH_TOKEN_CALENDAR`
    - `GOOGLE_CALENDAR_ID`
-   `GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_TOKEN_URI` are not used by booking calendar sync.

------------------------------------------------------------------------

## 2. Token Storage

-   Access tokens never stored in client.
-   Worker exchanges the refresh token at runtime and fetches a fresh access token before each Calendar call.
-   Refresh token remains in Worker secrets.

------------------------------------------------------------------------

## 3. Slot Calculation Logic

-   Query calendar for busy events.
-   Generate available slots within working hours.
-   Exclude slots held by calendar busy periods + active booking holds.

------------------------------------------------------------------------

## 4. Reservation Trigger + Execution

-   Slot reservation is triggered by finalized booking transitions (not button names):
    - pay later / free: after `EMAIL_CONFIRMED`
    - pay now: after `PAYMENT_SETTLED`
-   Reservation is attempted immediately in the same request/webhook flow.
-   On success:
    - create/update Google Calendar event
    - store `bookings.google_event_id`
-   On failure:
    - record a failed side-effect attempt in `booking_side_effect_attempts`
    - mark side effect as `failed`/`dead` based on `max_attempts`
    - emit structured error logs in `observability.logs`

------------------------------------------------------------------------

## 5. Reschedule Update Logic

-   Update existing Google event using stored `google_event_id`.
-   Cron may still process legacy/pending side effects, but fresh finalized reservations are immediate.

------------------------------------------------------------------------

## 6. Automatic Failure Recovery

-   Calendar write failures (`create`, `update`, `delete`) are captured as side-effect attempts:
    - `booking_side_effects.entity = 'calendar'`
    - `booking_side_effect_attempts.status = 'fail'`
    - `booking_side_effect_attempts.error_message` stores provider error
-   Retries are processed by the scheduled side-effects dispatcher job.
-   Side-effects cron is backup/janitor:
    - reminders
    - expirations
    - retrying failed/stuck work
-   Cron execution itself is traced through structured events in `observability.logs`; no separate `job_runs` table is used.
-   Retry behavior is bounded by `booking_side_effects.max_attempts`. After exhaustion:
    - side effect status moves to `dead`
    - full attempt history remains queryable
-   `bookings.google_event_id` is written only after successful event creation.

### Operator inspection

Use SQL to inspect calendar side-effect failures:

```sql
select
  se.id as booking_side_effect_id,
  be.booking_id,
  se.effect_intent,
  se.status as side_effect_status,
  sea.attempt_num,
  sea.status as attempt_status,
  sea.error_message,
  sea.created_at
from booking_side_effect_attempts sea
join booking_side_effects se on se.id = sea.booking_side_effect_id
join booking_events be on be.id = se.booking_event_id
where se.entity = 'calendar'
  and sea.status = 'fail'
order by sea.created_at desc;
```

Manual retry trigger (if needed):

```bash
curl -X POST "https://letsilluminate.co/api/jobs/side-effects-dispatcher" \
  -H "Authorization: Bearer $JOB_SECRET"
```
