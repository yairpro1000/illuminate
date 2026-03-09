# Admin Content System

This document describes the minimal content management system used by the application.

The system supports three primary content types:

1. Events
2. Session types (offers)
3. Bookings

Events and session types are admin-managed entities displayed on the public website.

Images associated with these entities are stored in Cloudflare R2 and backed up to Google Drive.

---

# Image Storage Architecture

Images uploaded by the admin are handled as follows:

1. Image uploaded from admin UI
2. Worker API receives file
3. File stored in Cloudflare R2
4. Same file uploaded to a specific Google Drive folder (backup)
5. Metadata stored in database

The database stores:

- image_key (R2 object key)
- drive_file_id (Google Drive file id)
- image_alt
- original filename

R2 is used as the production image host.
Google Drive is used only as a private backup.

R2 keys use prefix structure:

events/<uuid>.<ext>
sessions/<uuid>.<ext>

Object storage does not use real folders.

---

# Entities

## Events

Events represent group gatherings.

Fields:

id
title
slug
short_description
description
starts_at
ends_at
location
capacity
price
currency
status
image_key
drive_file_id
image_alt
created_at
updated_at

Status values:

draft
open
closed
cancelled

---

## Session Types

Session types represent bookable offers.

Examples:

Intro session
First 90-minute session
Cycle 60-minute session

Fields:

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

Status values:

draft
active
hidden

Session types populate the public "Book a session" page.

---

## Bookings

Bookings represent either:

- an event registration
- a booked session

Fields:

id
customer_name
customer_email
booking_kind
event_id
session_type_id
scheduled_at
payment_status
booking_status
stripe_payment_intent_id
refund_status
notes
created_at
updated_at

booking_kind values:

event
session

payment_status values:

pending
paid
failed
refunded

booking_status values:

active
cancelled
completed
no_show

---

# Admin UI

Admin routes:

/admin
/admin/events
/admin/session-types
/admin/bookings
/admin/messages

Events and session types support image upload.

Image upload triggers:

1. upload to R2
2. upload to Google Drive
3. save metadata to DB

---

# Image Upload Flow

Admin uploads image

Worker:

1. generate uuid filename
2. determine prefix (events/ or sessions/)
3. upload to R2
4. upload to Google Drive
5. store metadata in DB

Database stores only references, not binary data.

---

# Goals

The system must remain minimal and simple.

We expect:

small number of images
small number of events
small number of session types

Avoid building a full CMS.
