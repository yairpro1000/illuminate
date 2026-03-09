-- Booking-centric schema alignment (docs-first)
-- This migration intentionally removes legacy registration/attendee tables.

create extension if not exists "pgcrypto";

-- Enums used by current docs

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
  create type event_status as enum ('draft', 'published', 'cancelled', 'sold_out');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('pending', 'succeeded', 'failed', 'refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type failure_source as enum ('api', 'stripe_webhook', 'calendar', 'email', 'job', 'storage', 'auth');
exception when duplicate_object then null; end $$;

do $$ begin
  create type failure_severity as enum ('debug', 'info', 'warning', 'error', 'critical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type failure_status as enum ('open', 'retrying', 'resolved', 'ignored');
exception when duplicate_object then null; end $$;

do $$ begin
  create type contact_message_status as enum ('new', 'read', 'replied', 'archived', 'spam');
exception when duplicate_object then null; end $$;

-- clients
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text null,
  email text not null,
  phone text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table clients
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$ begin
  alter table clients alter column first_name set not null;
exception when others then null; end $$;
do $$ begin
  alter table clients alter column last_name drop not null;
exception when others then null; end $$;
do $$ begin
  alter table clients alter column email set not null;
exception when others then null; end $$;

create unique index if not exists idx_clients_email_unique on clients(lower(email));

-- events
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
  capacity integer not null default 24,
  status event_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table events
  add column if not exists timezone text not null default 'Europe/Zurich',
  add column if not exists location_name text,
  add column if not exists address_line text,
  add column if not exists maps_url text,
  add column if not exists is_paid boolean not null default false,
  add column if not exists price_per_person_cents integer,
  add column if not exists currency text not null default 'CHF',
  add column if not exists capacity integer not null default 24,
  add column if not exists status event_status not null default 'draft',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- bookings
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
  updated_at timestamptz not null default now()
);

alter table bookings
  add column if not exists source booking_source not null default 'session',
  add column if not exists event_id uuid,
  add column if not exists session_type text,
  add column if not exists attended boolean not null default false,
  add column if not exists notes text,
  add column if not exists checkout_session_id text,
  add column if not exists google_event_id text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Remove legacy booking columns no longer part of docs
alter table bookings drop column if exists booking_type;
alter table bookings drop column if exists attendee_count;
alter table bookings drop column if exists client_name;
alter table bookings drop column if exists client_email;
alter table bookings drop column if exists client_phone;

-- Ensure foreign keys

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_client_id_fkey'
  ) then
    alter table bookings
      add constraint bookings_client_id_fkey
      foreign key (client_id) references clients(id) on delete restrict;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_event_id_fkey'
  ) then
    alter table bookings
      add constraint bookings_event_id_fkey
      foreign key (event_id) references events(id) on delete restrict;
  end if;
end $$;

-- Replace old shape check with docs shape
alter table bookings drop constraint if exists bookings_source_shape;

do $$ begin
  alter table bookings
    add constraint bookings_source_shape check (
      (source = 'event' and event_id is not null) or
      (source = 'session' and event_id is null)
    );
exception when duplicate_object then null; end $$;

create index if not exists idx_bookings_client on bookings(client_id, created_at desc);
create index if not exists idx_bookings_event_status on bookings(event_id, status, starts_at) where event_id is not null;
create index if not exists idx_bookings_source_starts on bookings(source, starts_at);
create index if not exists idx_bookings_status on bookings(status);
create index if not exists idx_bookings_confirm_expires on bookings(confirm_expires_at) where confirm_expires_at is not null;
create index if not exists idx_bookings_hold_expires on bookings(checkout_hold_expires_at) where checkout_hold_expires_at is not null;
create index if not exists idx_bookings_payment_due on bookings(payment_due_at) where payment_due_at is not null;

-- Remove legacy registration/attendee model
drop table if exists event_registrations cascade;
drop table if exists event_attendees cascade;

-- payments: booking-linked only
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

alter table payments
  add column if not exists provider text,
  add column if not exists provider_payment_id text,
  add column if not exists checkout_url text,
  add column if not exists raw_payload jsonb,
  add column if not exists paid_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Migrate legacy stripe_checkout_session_id if present.
do $$ begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'payments' and column_name = 'stripe_checkout_session_id'
  ) then
    update payments
    set provider = coalesce(provider, 'stripe'),
        provider_payment_id = coalesce(provider_payment_id, stripe_checkout_session_id)
    where provider_payment_id is null;
  end if;
end $$;

alter table payments drop column if exists kind;
alter table payments drop column if exists event_registration_id;
alter table payments drop column if exists stripe_checkout_session_id;
alter table payments drop column if exists stripe_payment_intent_id;
alter table payments drop column if exists stripe_invoice_id;

create index if not exists idx_payments_booking on payments(booking_id, created_at desc);
create index if not exists idx_payments_status on payments(status, created_at desc);
create index if not exists idx_payments_provider_payment on payments(provider, provider_payment_id);

-- failure_logs: durable retry state and compact operational errors
create table if not exists failure_logs (
  id uuid primary key default gen_random_uuid(),
  source failure_source not null,
  operation text not null,
  severity failure_severity not null default 'error',
  status failure_status not null default 'open',
  request_id text null,
  idempotency_key text null,
  booking_id uuid null references bookings(id) on delete set null,
  payment_id uuid null references payments(id) on delete set null,
  client_id uuid null references clients(id) on delete set null,
  stripe_event_id text null,
  stripe_checkout_session_id text null,
  google_event_id text null,
  email_provider_message_id text null,
  error_code text null,
  error_message text not null,
  error_stack text null,
  http_status integer null,
  retryable boolean not null default true,
  context jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  next_retry_at timestamptz null,
  resolved_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table failure_logs
  add column if not exists source failure_source,
  add column if not exists operation text,
  add column if not exists severity failure_severity not null default 'error',
  add column if not exists status failure_status not null default 'open',
  add column if not exists request_id text,
  add column if not exists idempotency_key text,
  add column if not exists booking_id uuid,
  add column if not exists payment_id uuid,
  add column if not exists client_id uuid,
  add column if not exists stripe_event_id text,
  add column if not exists stripe_checkout_session_id text,
  add column if not exists google_event_id text,
  add column if not exists email_provider_message_id text,
  add column if not exists error_code text,
  add column if not exists error_message text,
  add column if not exists error_stack text,
  add column if not exists http_status integer,
  add column if not exists retryable boolean not null default true,
  add column if not exists context jsonb not null default '{}'::jsonb,
  add column if not exists attempts integer not null default 0,
  add column if not exists next_retry_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_failure_logs_status on failure_logs(status, created_at desc);
create index if not exists idx_failure_logs_source on failure_logs(source, created_at desc);
create index if not exists idx_failure_logs_request_id on failure_logs(request_id) where request_id is not null;
create index if not exists idx_failure_logs_booking on failure_logs(booking_id);
create index if not exists idx_failure_logs_payment on failure_logs(payment_id);
create index if not exists idx_failure_logs_client on failure_logs(client_id);
create index if not exists idx_failure_logs_stripe_event on failure_logs(stripe_event_id);
create index if not exists idx_failure_logs_next_retry on failure_logs(next_retry_at) where next_retry_at is not null;

alter table failure_logs drop column if exists job_run_id;

-- public contact form submissions
create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid null references clients(id) on delete set null,
  first_name text not null,
  last_name text null,
  email text not null,
  topic text null,
  message text not null,
  status contact_message_status not null default 'new',
  source text not null default 'website_contact_form',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table contact_messages
  add column if not exists client_id uuid,
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists email text,
  add column if not exists topic text,
  add column if not exists message text,
  add column if not exists status contact_message_status not null default 'new',
  add column if not exists source text not null default 'website_contact_form',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_contact_messages_status_created on contact_messages(status, created_at desc);
create index if not exists idx_contact_messages_email on contact_messages(email);
create index if not exists idx_contact_messages_client_id on contact_messages(client_id);

-- Reminder signup for Illuminate evenings
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

-- Late-access links
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
