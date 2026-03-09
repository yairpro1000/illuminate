# Database Schema (Supabase Postgres)

This document reflects the current simplified design:

- `bookings` is the single reservation table for both `session` and `event` flows.
- Every attendee is a real client with a `client_id`.
- There is no separate `event_registrations`, guest, or attendee table in the current design.
- Event check-in and organizer notes live directly on `bookings`.
- Late walk-in / after-start registration is handled by event-scoped signed access links.

> Notes:
> - Uses `pgcrypto` for UUIDs.
> - Public registration cutoffs must be enforced server-side, not just in frontend rendering.
> - `bookings.notes` may later be encrypted at the application layer if it starts holding sensitive 1:1 notes.

```sql
create extension if not exists "pgcrypto";

do $$ begin
  create type booking_source as enum ('session', 'event');
exception when duplicate_object then null; end $$;

do $$ begin
  create type booking_status as enum (
    'pending_email',
    'pending_payment',
    'confirmed',
    'cash_ok',
    'cancelled',
    'expired'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type event_status as enum (
    'draft',
    'published',
    'cancelled',
    'sold_out'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('pending', 'succeeded', 'failed', 'refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type media_type as enum ('image', 'video');
exception when duplicate_object then null; end $$;

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_clients_email_unique on clients(lower(email));

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Europe/Zurich',
  location_name text null,
  address_line text not null,
  maps_url text not null,
  is_paid boolean not null default false,
  price_per_person_cents integer null,
  currency text not null default 'CHF',
  capacity integer not null check (capacity > 0),
  status event_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_time_order check (ends_at > starts_at),
  constraint paid_event_requires_price
    check ((is_paid = false) or (price_per_person_cents is not null and price_per_person_cents > 0))
);

create index if not exists idx_events_status on events(status);
create index if not exists idx_events_starts_at on events(starts_at);

create table if not exists event_media (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  type media_type not null,
  storage_path text not null,
  alt_text text null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_event_media_event on event_media(event_id, sort_order);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete restrict,
  source booking_source not null,
  status booking_status not null,
  event_id uuid null references events(id) on delete restrict,
  session_type text null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Europe/Zurich',
  address_line text not null,
  maps_url text not null,
  attended boolean not null default false,
  notes text null,
  confirm_token_hash text null,
  confirm_expires_at timestamptz null,
  manage_token_hash text not null,
  checkout_session_id text null,
  checkout_hold_expires_at timestamptz null,
  payment_due_at timestamptz null,
  payment_due_reminder_scheduled_at timestamptz null,
  payment_due_reminder_sent_at timestamptz null,
  followup_scheduled_at timestamptz null,
  followup_sent_at timestamptz null,
  reminder_email_opt_in boolean not null default false,
  reminder_whatsapp_opt_in boolean not null default false,
  reminder_24h_scheduled_at timestamptz null,
  reminder_24h_sent_at timestamptz null,
  google_event_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_time_order check (ends_at > starts_at),
  constraint booking_source_shape check (
    (source = 'event' and event_id is not null) or
    (source = 'session' and event_id is null)
  )
);

create index if not exists idx_bookings_client on bookings(client_id, created_at desc);
create index if not exists idx_bookings_event_status on bookings(event_id, status, starts_at) where event_id is not null;
create index if not exists idx_bookings_source_starts on bookings(source, starts_at);
create index if not exists idx_bookings_status on bookings(status);
create index if not exists idx_bookings_confirm_expires on bookings(confirm_expires_at) where confirm_expires_at is not null;
create index if not exists idx_bookings_hold_expires on bookings(checkout_hold_expires_at) where checkout_hold_expires_at is not null;
create index if not exists idx_bookings_payment_due on bookings(payment_due_at) where payment_due_at is not null;

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  provider text not null,
  provider_payment_id text null,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'CHF',
  status payment_status not null default 'pending',
  checkout_url text null,
  invoice_url text null,
  raw_payload jsonb null,
  paid_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payments_booking on payments(booking_id, created_at desc);
create index if not exists idx_payments_status on payments(status, created_at desc);
create index if not exists idx_payments_provider_payment on payments(provider, provider_payment_id);

create table if not exists event_reminder_subscriptions (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  first_name text null,
  last_name text null,
  phone text null,
  event_family text not null default 'illuminate_evenings',
  created_at timestamptz not null default now(),
  unique (email, event_family)
);

create table if not exists event_late_access_links (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_by_client_id uuid null references clients(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null
);

create index if not exists idx_event_late_access_event on event_late_access_links(event_id, expires_at desc);
```

## Practical Rules

- One booking row represents one attendee.
- Event attendance is computed from `bookings` where `source = 'event'` and `event_id = ...`.
- Capacity should only count bookings that currently hold a seat according to product rules, not cancelled/expired rows.
- `attended` defaults to `false`; PA updates it manually after the event.
- `notes` is organizer-only operational text, not public content.
- Past-event visibility and “late access” windows are application rules, not database constraints.
