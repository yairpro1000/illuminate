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
