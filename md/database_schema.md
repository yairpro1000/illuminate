# Database Schema (Supabase Postgres)

This file contains the **implementation-ready SQL** for Phase I + structured Phase II placeholders.

> Notes:
> - Uses `pgcrypto` for UUIDs.
> - “Free event requires phone” is enforced in API logic (depends on event.is_paid).

```sql
create extension if not exists "pgcrypto";

do $$ begin
  create type booking_status as enum (
    'pending_email','pending_payment','confirmed','cash_ok','cancelled','expired'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type event_status as enum (
    'draft','published','cancelled','sold_out'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type registration_status as enum (
    'pending_email','pending_payment','confirmed','cancelled','expired'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_kind as enum ('booking','event_registration');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('pending','succeeded','failed','refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type media_type as enum ('image','video');
exception when duplicate_object then null; end $$;

-- BOOKINGS
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),

  client_name text not null,
  client_email text not null,
  client_phone text null,

  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Europe/Zurich',

  address_line text not null,
  maps_url text not null,

  status booking_status not null,

  confirm_token_hash text null,
  confirm_expires_at timestamptz null,

  manage_token_hash text not null,

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

create index if not exists idx_bookings_status on bookings(status);
create index if not exists idx_bookings_confirm_expires on bookings(confirm_expires_at);
create index if not exists idx_bookings_hold_expires on bookings(checkout_hold_expires_at);
create index if not exists idx_bookings_payment_due on bookings(payment_due_at);

-- EVENTS
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

  capacity integer null,
  status event_status not null default 'draft',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint paid_event_requires_price
    check ((is_paid = false) or (price_per_person_cents is not null and price_per_person_cents > 0))
);

create index if not exists idx_events_status on events(status);
create index if not exists idx_events_starts_at on events(starts_at);

-- EVENT MEDIA
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

-- EVENT REGISTRATIONS
create table if not exists event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,

  primary_name text not null,
  primary_email text not null,
  primary_phone text null,

  attendee_count integer not null default 1,
  status registration_status not null,

  confirm_token_hash text null,
  confirm_expires_at timestamptz null,

  manage_token_hash text not null,

  checkout_hold_expires_at timestamptz null,

  followup_scheduled_at timestamptz null,
  followup_sent_at timestamptz null,

  reminder_email_opt_in boolean not null default false,
  reminder_whatsapp_opt_in boolean not null default false,
  reminder_24h_scheduled_at timestamptz null,
  reminder_24h_sent_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint attendee_count_range check (attendee_count between 1 and 5)
);

create index if not exists idx_event_regs_event_status on event_registrations(event_id, status);
create index if not exists idx_event_regs_confirm_expires on event_registrations(confirm_expires_at);
create index if not exists idx_event_regs_hold_expires on event_registrations(checkout_hold_expires_at);

-- EVENT ATTENDEES
create table if not exists event_attendees (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references event_registrations(id) on delete cascade,
  full_name text not null,
  sort_order integer not null default 0
);

create index if not exists idx_event_attendees_reg on event_attendees(registration_id, sort_order);

-- PAYMENTS (unified)
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),

  kind payment_kind not null,
  booking_id uuid null references bookings(id) on delete cascade,
  event_registration_id uuid null references event_registrations(id) on delete cascade,

  stripe_checkout_session_id text not null,
  stripe_payment_intent_id text null,
  stripe_invoice_id text null,
  invoice_url text null,

  amount_cents integer not null,
  currency text not null,

  status payment_status not null default 'pending',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint exactly_one_parent check (
    (booking_id is not null and event_registration_id is null)
    or (booking_id is null and event_registration_id is not null)
  )
);

create index if not exists idx_payments_kind on payments(kind);
create index if not exists idx_payments_booking on payments(booking_id);
create index if not exists idx_payments_event_reg on payments(event_registration_id);
create index if not exists idx_payments_stripe_session on payments(stripe_checkout_session_id);

-- FUTURE PLACEHOLDERS (Phase II)
do $$ begin
  create type broadcast_channel as enum ('email','whatsapp');
exception when duplicate_object then null; end $$;

do $$ begin
  create type broadcast_status as enum ('draft','sending','sent','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type delivery_status as enum ('queued','sent','failed');
exception when duplicate_object then null; end $$;

create table if not exists broadcast_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  channel broadcast_channel not null,
  subject text null,
  body text not null,
  status broadcast_status not null default 'draft',
  created_at timestamptz not null default now()
);

create table if not exists broadcast_deliveries (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references broadcast_messages(id) on delete cascade,
  registration_id uuid not null references event_registrations(id) on delete cascade,
  status delivery_status not null default 'queued',
  attempts integer not null default 0,
  last_error text null,
  created_at timestamptz not null default now()
);
```

Here’s a practical, minimal-but-strong **`failure_logs`** table schema for your stack (Workers + Supabase). It’s designed for: webhooks, calendar, email, jobs, and general API failures—plus idempotent retries.

```sql
-- Optional enums (nice for consistency)
do $$ begin
  create type failure_source as enum ('api','stripe_webhook','calendar','email','job','storage','auth');
exception when duplicate_object then null; end $$;

do $$ begin
  create type failure_severity as enum ('debug','info','warning','error','critical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type failure_status as enum ('open','retrying','resolved','ignored');
exception when duplicate_object then null; end $$;

create table if not exists failure_logs (
  id uuid primary key default gen_random_uuid(),

  -- Where it came from
  source failure_source not null,
  operation text not null,              -- e.g. "stripe.checkout.session.completed", "calendar.create_event"
  severity failure_severity not null default 'error',
  status failure_status not null default 'open',

  -- Correlation / trace
  request_id text null,                 -- Worker-generated correlation id
  idempotency_key text null,            -- if you have one for the operation
  job_run_id uuid null,                 -- if produced by a scheduled job run

  -- Entity links (nullable; fill what you have)
  booking_id uuid null references bookings(id) on delete set null,
  event_id uuid null references events(id) on delete set null,
  event_registration_id uuid null references event_registrations(id) on delete set null,
  payment_id uuid null references payments(id) on delete set null,

  -- External references
  stripe_event_id text null,
  stripe_checkout_session_id text null,
  google_event_id text null,
  email_provider_message_id text null,

  -- Error details (keep it safe)
  error_code text null,
  error_message text not null,
  error_stack text null,                -- optional; avoid dumping secrets
  http_status integer null,
  retryable boolean not null default true,

  -- Small structured context (safe subset only)
  context jsonb not null default '{}'::jsonb,

  -- Retry tracking (optional but useful)
  attempts integer not null default 0,
  next_retry_at timestamptz null,
  resolved_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Helpful indexes
create index if not exists idx_failure_logs_status on failure_logs(status, created_at desc);
create index if not exists idx_failure_logs_source on failure_logs(source, created_at desc);
create index if not exists idx_failure_logs_booking on failure_logs(booking_id);
create index if not exists idx_failure_logs_event_reg on failure_logs(event_registration_id);
create index if not exists idx_failure_logs_stripe_event on failure_logs(stripe_event_id);
create index if not exists idx_failure_logs_next_retry on failure_logs(next_retry_at) where next_retry_at is not null;
```

A few rules that make this table actually useful:

* **Always write `request_id`** (generate one per API request/job run) so you can trace a whole flow.
* Put only **safe context** in `context` (no tokens, no raw webhook payloads, no secrets).
* If you implement retries, increment `attempts` and set `next_retry_at`.


Good. Let’s give your future self observability instead of guesswork.

Here’s a clean companion table: **`job_runs`** — one row per scheduler execution.

This lets you answer:

* Did the job run?
* How long did it take?
* How many items were processed?
* Did it partially fail?
* Which failures belong to which run?

---

## `job_runs` Table

```sql
do $$ begin
  create type job_status as enum ('running','success','partial_failure','failed');
exception when duplicate_object then null; end $$;

create table if not exists job_runs (
  id uuid primary key default gen_random_uuid(),

  job_name text not null,               -- e.g. "send-payment-due-reminders"
  status job_status not null default 'running',

  started_at timestamptz not null default now(),
  finished_at timestamptz null,

  -- Metrics
  items_found integer not null default 0,
  items_processed integer not null default 0,
  items_succeeded integer not null default 0,
  items_failed integer not null default 0,

  -- Optional correlation
  trigger_source text not null default 'scheduler',  -- scheduler | manual | retry
  request_id text null,                              -- correlation id

  -- Optional summary
  error_summary text null,

  created_at timestamptz not null default now()
);

create index if not exists idx_job_runs_name on job_runs(job_name, started_at desc);
create index if not exists idx_job_runs_status on job_runs(status, started_at desc);
```

---

## How It Works With `failure_logs`

When a job runs:

1. Insert into `job_runs` with `status = 'running'`.
2. Process items.
3. For each failure:

   * Insert into `failure_logs`
   * Link via `job_run_id`
4. Update counters.
5. Set:

   * `status = success` if zero failures
   * `status = partial_failure` if some failed
   * `status = failed` if catastrophic
6. Set `finished_at`.

Now you have:

* Macro view → `job_runs`
* Micro view → `failure_logs`

That’s the difference between “I think reminders didn’t send” and “I know 3 of 42 failed due to Google 500 errors.”

If you want to go one level deeper, we can add lightweight structured logging strategy for Workers so everything shares a correlation ID automatically.


