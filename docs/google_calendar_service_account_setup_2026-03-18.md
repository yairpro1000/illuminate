# Google Calendar Service Account Setup - 2026-03-18

## Scope

This setup applies to `apps/api-booking` Google Calendar integration only.

The booking worker now supports one live Google Calendar auth mode:

- service account JSON via `GOOGLE_SERVICE_ACCOUNT_JSON`

No OAuth refresh-token flow is supported in the booking calendar provider.

## Required Environment Variables

- `CALENDAR_MODE=google`
- `GOOGLE_CALENDAR_ID=<target calendar id>`
- `GOOGLE_SERVICE_ACCOUNT_JSON=<full Google service account JSON>`

`GOOGLE_SERVICE_ACCOUNT_JSON` must contain:

- `client_email`
- `private_key`
- optionally `token_uri`

If `token_uri` is absent, the provider defaults to `https://oauth2.googleapis.com/token`.

## Required Google Setup

1. Create or choose a Google Cloud service account for the booking worker.
2. Generate a JSON key for that service account.
3. Copy the full JSON into the `GOOGLE_SERVICE_ACCOUNT_JSON` secret for the target deployment environment.
4. Open the target Google Calendar in Google Calendar settings.
5. Share that calendar with the service account `client_email` from the JSON key.
6. Grant the service account permission to modify events on that calendar.
7. Set `GOOGLE_CALENDAR_ID` to that same calendar's id.

## Runtime Behavior

- `getBusyTimes()` uses the service account JSON to mint a JWT bearer token and calls Google `freeBusy`.
- `createEvent()` uses the same service account JSON to call Google `events.insert`.
- `updateEvent()` uses the same service account JSON to call Google `events.update`.
- `deleteEvent()` uses the same service account JSON to call Google `events.delete`.

If `GOOGLE_SERVICE_ACCOUNT_JSON` is missing or malformed, the provider fails before any Google fetch and logs:

- `eventType=google_calendar_service_account_config_invalid`
- `branch_taken=abort_calendar_operation_missing_service_account_json`

## Deployment Notes

- The service account must be shared directly on the target calendar. Domain-wide delegation is not part of this integration.
- Rotating the key means updating `GOOGLE_SERVICE_ACCOUNT_JSON` in every deployment environment that runs `apps/api-booking`.
- Old refresh-token variables are not part of the booking calendar path and should not be used for this worker.
