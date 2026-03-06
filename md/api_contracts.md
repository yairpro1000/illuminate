# API Contracts

This file specifies **endpoints, payloads, and rules** for Phase I.

## Conventions

- All public POST endpoints require an anti-bot token: `turnstile_token` (or equivalent reCAPTCHA).
- Stripe webhook endpoint verifies signature header (Stripe signing secret).
- “Manage” links use a signed token; server validates against stored `*_token_hash`.
- All job endpoints are **idempotent** and protected via a secret header (e.g., `X-Job-Token`).
- PA endpoints are protected by **Cloudflare Access** (no public auth/session endpoints).

---

## Public: Slots & Booking

### `GET /api/slots?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Europe/Zurich`

**200**
```json
{
  "timezone": "Europe/Zurich",
  "slots": [
    { "start": "2026-03-10T10:00:00+01:00", "end": "2026-03-10T11:00:00+01:00" }
  ]
}
```

---

### `POST /api/bookings/pay-now`

Creates a booking in `pending_payment`, starts a Stripe Checkout session, and sets a **15-minute hold**.

**Body**
```json
{
  "slot_start": "2026-03-10T10:00:00+01:00",
  "slot_end": "2026-03-10T11:00:00+01:00",
  "timezone": "Europe/Zurich",
  "client_name": "Alice",
  "client_email": "alice@example.com",
  "client_phone": "+41790000000",
  "reminder_email_opt_in": true,
  "reminder_whatsapp_opt_in": false,
  "turnstile_token": "..."
}
```

**200**
```json
{
  "booking_id": "uuid",
  "checkout_url": "https://checkout.stripe.com/...",
  "checkout_hold_expires_at": "2026-03-09T12:15:00Z"
}
```

---

### `POST /api/bookings/pay-later`

Creates booking in `pending_email` and emails a confirmation link.

**Body**
```json
{
  "slot_start": "2026-03-10T10:00:00+01:00",
  "slot_end": "2026-03-10T11:00:00+01:00",
  "timezone": "Europe/Zurich",
  "client_name": "Alice",
  "client_email": "alice@example.com",
  "client_phone": "+41790000000",
  "reminder_email_opt_in": true,
  "turnstile_token": "..."
}
```

**200**
```json
{ "booking_id": "uuid", "status": "pending_email" }
```

---

### `GET /api/bookings/confirm?token=...`

Confirms email for pay-later booking. Creates calendar event, moves to `pending_payment`, computes payment due + reminder schedule, and emails a payment link.

**200**
```json
{
  "booking_id": "uuid",
  "status": "pending_payment",
  "payment_due_at": "2026-03-09T10:00:00+01:00",
  "payment_due_reminder_scheduled_at": "2026-03-08T18:00:00+01:00"
}
```

---

### `GET /api/bookings/manage?token=...`

Returns details for manage page.

**200**
```json
{
  "booking_id": "uuid",
  "status": "confirmed",
  "start": "2026-03-10T10:00:00+01:00",
  "end": "2026-03-10T11:00:00+01:00",
  "address_line": "Street 1, 6900 Lugano",
  "maps_url": "https://maps.google.com/?q=...",
  "actions": { "can_reschedule": true, "can_cancel": true }
}
```

---

### `POST /api/bookings/reschedule`

**Body**
```json
{
  "token": "...",
  "new_start": "2026-03-11T10:00:00+01:00",
  "new_end": "2026-03-11T11:00:00+01:00",
  "timezone": "Europe/Zurich"
}
```

**200**
```json
{ "booking_id": "uuid", "status": "confirmed" }
```

---

### `POST /api/bookings/cancel`

**Body**
```json
{ "token": "..." }
```

**200**
```json
{ "booking_id": "uuid", "status": "cancelled" }
```

---

## Public: Events

### `GET /api/events`

**200**
```json
{
  "events": [
    {
      "id": "uuid",
      "slug": "clarity-circle-lugano",
      "title": "Clarity Circle",
      "starts_at": "2026-03-20T19:00:00+01:00",
      "ends_at": "2026-03-20T21:00:00+01:00",
      "address_line": "Street 1, 6900 Lugano",
      "maps_url": "https://maps.google.com/?q=...",
      "is_paid": true,
      "price_per_person_cents": 4500,
      "currency": "CHF",
      "media": [{ "type": "image", "url": "..." }]
    }
  ]
}
```

---

### `GET /api/events/:slug`

Returns full event details + ordered media.

---

### `POST /api/events/:slug/register`

Creates a registration and either sends an email confirmation (free) or starts Stripe Checkout (paid).

**Body**
```json
{
  "primary_name": "Alice",
  "primary_email": "alice@example.com",
  "primary_phone": "+41790000000",
  "attendees": ["Bob", "Carol"],
  "reminder_email_opt_in": true,
  "reminder_whatsapp_opt_in": false,
  "turnstile_token": "..."
}
```

**200 (free event)**
```json
{ "registration_id": "uuid", "status": "pending_email" }
```

**200 (paid event)**
```json
{
  "registration_id": "uuid",
  "status": "pending_payment",
  "checkout_url": "https://checkout.stripe.com/...",
  "checkout_hold_expires_at": "2026-03-19T12:15:00Z"
}
```

**Rules**
- Free event: `primary_phone` is required.
- Attendee count = 1 + `attendees.length`, must be 1..5.
- For paid events: total amount = `price_per_person_cents * attendee_count`.

---

### `GET /api/event-registrations/confirm?token=...`

Confirms email for a free event registration.

**200**
```json
{ "registration_id": "uuid", "status": "confirmed" }
```

---

### `GET /api/event-registrations/manage?token=...`

**200**
```json
{
  "registration_id": "uuid",
  "status": "confirmed",
  "event": {
    "title": "Clarity Circle",
    "starts_at": "2026-03-20T19:00:00+01:00",
    "maps_url": "https://maps.google.com/?q=..."
  },
  "actions": { "can_cancel": true }
}
```

---

### `POST /api/event-registrations/cancel`

**Body**
```json
{ "token": "..." }
```

**200**
```json
{ "registration_id": "uuid", "status": "cancelled" }
```

---

# PA (Private Admin) API (V1)

PA endpoints are served by the Worker under `/api/*` and are expected to be accessible only behind Cloudflare Access.

## Headers

- `cf-access-authenticated-user-email`: provided by Cloudflare Access
- `x-pa-device-id`: frontend-generated stable device id (used to populate `items_updated_by`)

## `GET /api/lists`

**200**
```json
{
  "lists": [
    {
      "id": "app",
      "title": "App",
      "description": "",
      "aliases": [],
      "fields": { "text": { "type": "string" } },
      "ui": { "defaultSort": "createdAt" },
      "meta": { "revision": 12, "itemsUpdatedAt": "2026-03-05T10:00:00Z", "itemsUpdatedBy": "me@example.com_device" }
    }
  ]
}
```

## `POST /api/lists/:listId/reorder` (atomic + conflict-safe)

Reorders items within a priority bucket using **list-level optimistic concurrency**.

**Body**
```json
{ "priority": 3, "orderedIds": ["uuid1", "uuid2"], "expectedRevision": 12 }
```

- If the DB revision changed since the UI loaded, returns **409** (conflict).

## `POST /api/commit` (optimistic concurrency for update/delete)

**Body**
```json
{
  "action": { "type": "update_item", "valid": true, "confidence": 1, "listId": "app", "itemId": "uuid", "patch": { "text": "..." } },
  "expected": { "itemUpdatedAt": "2026-03-05T10:00:00Z" }
}
```

- For update/delete, if `itemUpdatedAt` does not match the current DB value, returns **409** (conflict).

---

## Stripe Webhook

### `POST /api/stripe/webhook`

Handles at minimum:
- `checkout.session.completed` → mark payment succeeded → confirm booking/registration → send confirmation email

**200**
```json
{ "ok": true }
```

Requirements:
- Verify Stripe signature header.
- Idempotent handling (webhook retries).
- Safe if invoked multiple times.

---

## Internal Jobs (Scheduler-Agnostic)

All require a secret header (e.g., `X-Job-Token`).

### `POST /internal/jobs/expire-checkout-holds`
- Expire bookings/registrations where `checkout_hold_expires_at < now` and unpaid.

### `POST /internal/jobs/send-followups`
- Send follow-up emails for:
  - unconfirmed email confirmations (`pending_email` after +2h)
  - paid event checkout abandoned (unpaid after +2h)

### `POST /internal/jobs/send-reminders-24h`
- Send 24h reminders for confirmed bookings/registrations with opt-in.

### `POST /internal/jobs/send-payment-due-reminders`
- Send payment-due reminders for pay-later bookings, using computed `payment_due_reminder_scheduled_at`.

### `POST /internal/jobs/cancel-overdue-unpaid-bookings`
- Cancel bookings at `payment_due_at` when still `pending_payment` (unless `cash_ok`).
