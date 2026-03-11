# Admin Content System

This document describes the admin-managed entities and the booking read model after the booking-domain reset.

## Managed Entities

1. Events
2. Session types
3. Bookings

Images are stored in Cloudflare R2 and optionally mirrored to Google Drive backup.

## Events

Admin-managed fields:

```text
id
slug
title
description
starts_at
ends_at
timezone
location_name
address_line
maps_url
is_paid
price_per_person_cents
currency
capacity
status
image_key
drive_file_id
image_alt
created_at
updated_at
```

`status`:

```text
draft
published
cancelled
sold_out
```

## Session Types

Admin-managed fields:

```text
id
title
slug
short_description
description
duration_minutes
price
currency
status
sort_order
image_key
drive_file_id
image_alt
created_at
updated_at
```

`status`:

```text
draft
active
hidden
```

## Booking Model (Admin View)

### Architecture

`bookings`
- Stable facts and current-status cache only.

`booking_events`
- Canonical business timeline.

`booking_side_effects`
- Intended reactions from events.

`booking_side_effect_attempts`
- Retry/execution history per side effect.

### Booking Fields

```text
id
client_id
event_id
session_type_id
starts_at
ends_at
timezone
google_event_id
address_line
maps_url
current_status
notes
created_at
updated_at
```

`current_status`:

```text
PENDING_CONFIRMATION
SLOT_CONFIRMED
PAID
EXPIRED
CANCELED
CLOSED
```

### Canonical Event and Effect Values

`booking_events.source`:

```text
public_ui
admin_ui
job
webhook
system
```

`booking_side_effects.entity`:

```text
email
calendar
payment
system
```

`booking_side_effects.status`:

```text
pending
processing
success
failed
dead
```

`booking_side_effect_attempts.status`:

```text
success
fail
```

## Admin APIs

`GET /api/admin/bookings` supports filters:

```text
source=event|session        (mapped to booking_kind internally)
event_id=<uuid>
date=YYYY-MM-DD
client_id=<uuid>
status=<current_status>
```

Rows include:

```text
booking_id
current_status
event_id
event_title
session_type_id
session_type_title
starts_at
ends_at
timezone
notes
client_id
client_first_name
client_last_name
client_email
client_phone
```

`PATCH /api/admin/bookings/:bookingId` supports admin edits for:

```text
client.first_name
client.last_name
client.email
client.phone
booking.notes
```

No `attended` field exists in the current model.
