-- Fresh-model schema baseline for booking domain and related app tables.
-- This migration is intentionally create-only (no ALTER/backfill logic).

create extension if not exists "pgcrypto";

do $$ begin
  create type event_status as enum ('draft', 'published', 'cancelled', 'sold_out');
exception when duplicate_object then null; end $$;

do $$ begin
  create type session_type_status as enum ('draft', 'active', 'hidden');
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

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text null,
  email text not null,
  phone text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_clients_email_unique on clients(lower(email));

create table if not exists session_types (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  short_description text null,
  description text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  price integer not null check (price >= 0),
  currency text not null default 'CHF',
  status session_type_status not null default 'draft',
  sort_order integer not null default 0,
  image_key text null,
  drive_file_id text null,
  image_alt text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_session_types_status_order on session_types(status, sort_order, created_at);

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
  image_key text null,
  drive_file_id text null,
  image_alt text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_time_order check (ends_at > starts_at),
  constraint paid_event_requires_price
    check ((is_paid = false) or (price_per_person_cents is not null and price_per_person_cents > 0))
);

create index if not exists idx_events_status_starts on events(status, starts_at);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete restrict,
  event_id uuid null references events(id) on delete restrict,
  session_type_id uuid null references session_types(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Europe/Zurich',
  google_event_id text null,
  address_line text not null,
  maps_url text not null,
  current_status text not null check (
    current_status in ('PENDING_CONFIRMATION', 'SLOT_CONFIRMED', 'PAID', 'EXPIRED', 'CANCELED', 'CLOSED')
  ),
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_time_order check (ends_at > starts_at),
  constraint bookings_exactly_one_kind check (
    ((event_id is not null)::int + (session_type_id is not null)::int) = 1
  )
);

create index if not exists idx_bookings_client_created on bookings(client_id, created_at desc);
create index if not exists idx_bookings_event_status_start on bookings(event_id, current_status, starts_at) where event_id is not null;
create index if not exists idx_bookings_session_status_start on bookings(session_type_id, current_status, starts_at) where session_type_id is not null;
create index if not exists idx_bookings_status_start on bookings(current_status, starts_at);
create index if not exists idx_bookings_google_event_id on bookings(google_event_id) where google_event_id is not null;

create table if not exists booking_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  event_type text not null check (
    event_type in (
      'BOOKING_FORM_SUBMITTED_FREE',
      'BOOKING_FORM_SUBMITTED_PAY_NOW',
      'BOOKING_FORM_SUBMITTED_PAY_LATER',
      'EMAIL_CONFIRMED',
      'BOOKING_RESCHEDULED',
      'SLOT_RESERVATION_REMINDER_SENT',
      'PAYMENT_REMINDER_SENT',
      'DATE_REMINDER_SENT',
      'BOOKING_EXPIRED',
      'BOOKING_CANCELED',
      'CASH_AUTHORIZED',
      'PAYMENT_SETTLED',
      'SLOT_CONFIRMED',
      'BOOKING_CLOSED'
    )
  ),
  source text not null check (source in ('public_ui', 'admin_ui', 'job', 'webhook', 'system')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_booking_events_booking_created on booking_events(booking_id, created_at desc);
create index if not exists idx_booking_events_type_created on booking_events(event_type, created_at desc);
create index if not exists idx_booking_events_confirm_token_hash
  on booking_events((payload ->> 'confirm_token_hash'), created_at desc)
  where payload ? 'confirm_token_hash';

create table if not exists booking_side_effects (
  id uuid primary key default gen_random_uuid(),
  booking_event_id uuid not null references booking_events(id) on delete cascade,
  entity text not null check (entity in ('email', 'calendar', 'payment', 'whatsapp')),
  effect_intent text not null check (
    effect_intent in (
      'send_email_confirmation',
      'send_slot_reservation_reminder',
      'send_payment_reminder',
      'send_date_reminder',
      'send_booking_failed_notification',
      'send_booking_cancellation_confirmation',
      'reserve_slot',
      'update_reserved_slot',
      'cancel_reserved_slot',
      'confirm_reserved_slot',
      'create_stripe_checkout',
      'verify_stripe_payment',
      'send_payment_link',
      'expire_booking',
      'close_booking'
    )
  ),
  status text not null check (status in ('pending', 'processing', 'success', 'failed', 'dead')),
  expires_at timestamptz null,
  max_attempts integer not null default 5 check (max_attempts >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_booking_side_effects_status_created on booking_side_effects(status, created_at);
create index if not exists idx_booking_side_effects_event_created on booking_side_effects(booking_event_id, created_at);
create index if not exists idx_booking_side_effects_pending_due
  on booking_side_effects(expires_at, created_at)
  where status in ('pending', 'failed');
create index if not exists idx_booking_side_effects_intent_status on booking_side_effects(effect_intent, status, created_at);

create table if not exists booking_side_effect_attempts (
  id uuid primary key default gen_random_uuid(),
  booking_side_effect_id uuid not null references booking_side_effects(id) on delete cascade,
  attempt_num integer not null check (attempt_num >= 1),
  api_log_id text null,
  status text not null check (status in ('success', 'fail')),
  error_message text null,
  created_at timestamptz not null default now(),
  unique (booking_side_effect_id, attempt_num)
);

create index if not exists idx_booking_side_effect_attempts_effect_created
  on booking_side_effect_attempts(booking_side_effect_id, created_at desc);

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

create index if not exists idx_failure_logs_status on failure_logs(status, created_at desc);
create index if not exists idx_failure_logs_source on failure_logs(source, created_at desc);
create index if not exists idx_failure_logs_request_id on failure_logs(request_id) where request_id is not null;
create index if not exists idx_failure_logs_booking on failure_logs(booking_id);
create index if not exists idx_failure_logs_payment on failure_logs(payment_id);
create index if not exists idx_failure_logs_client on failure_logs(client_id);
create index if not exists idx_failure_logs_stripe_event on failure_logs(stripe_event_id);
create index if not exists idx_failure_logs_next_retry on failure_logs(next_retry_at) where next_retry_at is not null;
create index if not exists idx_failure_logs_calendar_sync_due
  on failure_logs(next_retry_at, booking_id)
  where source = 'calendar'
    and operation = 'calendar_sync'
    and retryable = true
    and resolved_at is null
    and next_retry_at is not null;
create unique index if not exists idx_failure_logs_calendar_sync_active_unique
  on failure_logs(booking_id)
  where source = 'calendar'
    and operation = 'calendar_sync'
    and resolved_at is null;

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

create index if not exists idx_contact_messages_status_created on contact_messages(status, created_at desc);
create index if not exists idx_contact_messages_email on contact_messages(email);
create index if not exists idx_contact_messages_client_id on contact_messages(client_id);

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

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_clients_updated_at
before update on clients
for each row execute function set_updated_at();

create trigger trg_session_types_updated_at
before update on session_types
for each row execute function set_updated_at();

create trigger trg_events_updated_at
before update on events
for each row execute function set_updated_at();

create trigger trg_bookings_updated_at
before update on bookings
for each row execute function set_updated_at();

create trigger trg_booking_side_effects_updated_at
before update on booking_side_effects
for each row execute function set_updated_at();

create trigger trg_payments_updated_at
before update on payments
for each row execute function set_updated_at();

create trigger trg_failure_logs_updated_at
before update on failure_logs
for each row execute function set_updated_at();

create trigger trg_contact_messages_updated_at
before update on contact_messages
for each row execute function set_updated_at();
