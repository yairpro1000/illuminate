# API Contracts

## Ownership

### Booking/admin worker: `apps/api-booking`

- `letsilluminate.co/api/*`
- `admin.letsilluminate.co/api/*`

### PA worker: `apps/api-pa`

- `pa.letsilluminate.co/api/*`

## Dev-stage rules

- Booking persistence is live against Supabase in `apps/api-booking`.
- Payments are explicitly mock-first.
- Anti-bot is explicitly mock-first.
- Public/admin contracts must still remain stable even while those providers are mocked.
- `job_runs` does not exist.
- Durable calendar retry state lives in `failure_logs`.

## Public booking API

### `GET /api/slots?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Europe/Zurich&type=intro|session`

Returns available 1:1 slots.

### `POST /api/bookings/pay-now`

Valid only for paid 1:1 sessions (`type: "session"`). `intro` is free and should use the standard confirmation flow.

Request:

```json
{
  "slot_start": "2026-03-10T10:00:00+01:00",
  "slot_end": "2026-03-10T11:00:00+01:00",
  "timezone": "Europe/Zurich",
  "type": "session",
  "client_name": "Alice Example",
  "client_email": "alice@example.com",
  "client_phone": "+41790000000",
  "reminder_email_opt_in": true,
  "reminder_whatsapp_opt_in": false,
  "turnstile_token": "placeholder"
}
```

Response:

```json
{
  "booking_id": "uuid",
  "checkout_url": "https://mock-checkout.example/...",
  "checkout_hold_expires_at": "2026-03-09T12:15:00Z"
}
```

### `POST /api/bookings/pay-later`

Same input shape as pay-now, but `type` may be `intro` or `session`.

Response:

```json
{
  "booking_id": "uuid",
  "status": "pending_email"
}
```

### `GET /api/bookings/confirm?token=...`

Confirms a pay-later or free-event email link and returns the next public action so the frontend does not depend on email arrival.

Response:

```json
{
  "booking_id": "uuid",
  "status": "pending_payment",
  "source": "session",
  "checkout_url": "https://mock-checkout.example/...",
  "manage_url": "https://letsilluminate.co/manage.html?token=...",
  "next_action_url": "https://mock-checkout.example/...",
  "next_action_label": "Complete Payment"
}
```

### `GET /api/bookings/payment-status?session_id=...`

Returns a public-safe recovery view for a completed checkout session.

```json
{
  "booking_id": "uuid",
  "status": "confirmed",
  "source": "event",
  "checkout_url": null,
  "manage_url": "https://letsilluminate.co/manage.html?token=...",
  "next_action_url": "https://letsilluminate.co/manage.html?token=...",
  "next_action_label": "Manage Booking"
}
```

### `GET /api/bookings/manage?token=...`

Public/manage-safe booking lookup. Organizer-only fields such as `notes` and `attended` must not appear here.

Response:

```json
{
  "booking_id": "uuid",
  "source": "session",
  "status": "confirmed",
  "session_type": "intro",
  "starts_at": "2026-03-10T10:00:00+01:00",
  "ends_at": "2026-03-10T11:00:00+01:00",
  "timezone": "Europe/Zurich",
  "address_line": "Via Example 1, 6900 Lugano",
  "maps_url": "https://maps.google.com/?q=Lugano+Switzerland",
  "payment_due_at": null,
  "client": {
    "first_name": "Alice",
    "last_name": "Example",
    "email": "alice@example.com",
    "phone": "+41790000000"
  },
  "actions": {
    "can_reschedule": true,
    "can_cancel": true
  }
}
```

### `POST /api/bookings/reschedule`

Request:

```json
{
  "token": "...",
  "new_start": "2026-03-11T10:00:00+01:00",
  "new_end": "2026-03-11T11:00:00+01:00",
  "timezone": "Europe/Zurich"
}
```

### `POST /api/bookings/cancel`

Request:

```json
{ "token": "..." }
```

## Public event API

### `GET /api/events`

Returns published events with render metadata:

- `stats.active_bookings`
- `stats.capacity`
- `render.public_registration_open`
- `render.sold_out`
- `render.show_reminder_signup_cta`
- `render.late_access_active`

### `GET /api/events/:slug`

Returns one published event plus the same render metadata.

### `POST /api/events/:slug/book`

Request:

```json
{
  "first_name": "Alice",
  "last_name": "Example",
  "email": "alice@example.com",
  "phone": "+41790000000",
  "reminder_email_opt_in": true,
  "reminder_whatsapp_opt_in": false,
  "turnstile_token": "placeholder"
}
```

Free event response:

```json
{
  "booking_id": "uuid",
  "status": "pending_email"
}
```

Paid event response:

```json
{
  "booking_id": "uuid",
  "status": "pending_payment",
  "checkout_url": "https://mock-checkout.example/...",
  "checkout_hold_expires_at": "2026-03-19T12:15:00Z"
}
```

### `POST /api/events/:slug/book-with-access`

Same as normal event booking plus:

```json
{ "access_token": "..." }
```

### `POST /api/events/reminder-subscriptions`

Request:

```json
{
  "email": "alice@example.com",
  "first_name": "Alice",
  "last_name": "Example",
  "phone": "+41790000000",
  "event_family": "illuminate_evenings"
}
```

## Public contact API

### `POST /api/contact`

Canonical request:

```json
{
  "first_name": "Alice",
  "last_name": "Example",
  "email": "alice@example.com",
  "topic": "Question",
  "message": "Hello",
  "turnstile_token": "placeholder"
}
```

Legacy `name` is accepted as an input alias in dev, but the canonical contract is `first_name` + optional `last_name`.

## Organizer/admin API

These routes are served by `apps/api-booking`, not by the PA worker.

### `GET /api/admin/events`

Returns organizer-visible events.

### `GET /api/admin/bookings`

Query params:

- `source=event|session`
- `event_id=...`
- `date=YYYY-MM-DD`
- `client_id=...`
- `status=...`

Response rows include organizer-only fields such as `attended` and `notes`.

### `PATCH /api/admin/bookings/:bookingId`

Request:

```json
{
  "client": {
    "first_name": "Alice",
    "last_name": "Example",
    "email": "alice@example.com",
    "phone": "+41790000000"
  },
  "booking": {
    "attended": true,
    "notes": "Organizer-only note"
  }
}
```

### `POST /api/admin/events/:eventId/late-access-links`

Returns a late-access booking URL on `letsilluminate.co/book.html?...&access=...`.

### `POST /api/admin/reminder-subscriptions`

Creates or updates an `event_reminder_subscriptions` row.

## Booking jobs

### `POST /api/jobs/:name`

Authorization:

```text
Authorization: Bearer <JOB_SECRET>
```

Supported names:

- `checkout-expiry`
- `calendar-sync-retries`
- `unconfirmed-followups`
- `payment-due-reminders`
- `payment-due-cancellations`
- `24h-reminders`

## PA API

PA-only routes are served by `apps/api-pa` on `pa.letsilluminate.co/api/*`.

Key routes:

- `GET /api/health`
- `POST /api/observability/frontend`
- `GET /api/me`
- `GET /api/config`
- `GET /api/lists`
- `GET /api/lists/:listId/items`
- `POST /api/lists/:listId/reorder`
- `POST /api/parse`
- `POST /api/translate`
- `POST /api/translate/refine`
- `POST /api/commit`
- `GET /api/undo`
- `POST /api/undo`
- `GET /api/export/csv/:listId`
- `GET /api/export/xlsx/:listId`
- `POST /api/email`
- `POST /api/speak`
