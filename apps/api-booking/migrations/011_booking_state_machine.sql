-- Booking state machine refactor (additive, ALTER-based)

-- Main: extend bookings table with new lifecycle fields
alter table bookings
  add column if not exists booking_status text,
  add column if not exists payment_mode text,
  add column if not exists payment_status_v2 text,
  add column if not exists email_status text,
  add column if not exists calendar_status text,
  add column if not exists slot_status text,
  add column if not exists hold_expires_at timestamptz,
  add column if not exists email_confirmed_at timestamptz,
  add column if not exists confirmed_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists expired_at timestamptz,
  add column if not exists reminder_36h_sent_at timestamptz,
  add column if not exists last_payment_link_sent_at timestamptz,
  add column if not exists expired_reason text,
  add column if not exists cancel_reason text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Constraints (CHECK) for new enumerations
do $$ begin
  alter table bookings
    add constraint booking_status_lite_check
      check (booking_status is null or booking_status in ('pending','confirmed','cancelled','expired'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table bookings
    add constraint payment_mode_check
      check (payment_mode is null or payment_mode in ('free','pay_now','pay_later'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table bookings
    add constraint payment_status_v2_check
      check (payment_status_v2 is null or payment_status_v2 in ('not_required','pending','paid'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table bookings
    add constraint email_status_check
      check (email_status is null or email_status in ('not_required','pending_confirmation','confirmed','expired'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table bookings
    add constraint calendar_status_check
      check (calendar_status is null or calendar_status in ('not_required','pending','created','removed'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table bookings
    add constraint slot_status_check
      check (slot_status is null or slot_status in ('reserved','released'));
exception when duplicate_object then null; end $$;

-- Backfill pass 1: set hold_expires_at from existing checkout_hold_expires_at
update bookings
set hold_expires_at = coalesce(hold_expires_at, checkout_hold_expires_at)
where checkout_hold_expires_at is not null and hold_expires_at is null;

-- Backfill pass 1b: if still null, set hold_expires_at from confirm_expires_at
update bookings
set hold_expires_at = confirm_expires_at
where hold_expires_at is null and confirm_expires_at is not null;

-- Backfill pass 2: derive new lifecycle fields from legacy columns
-- pending vs confirmed vs cancelled vs expired
update bookings
set booking_status = case
  when status in ('confirmed','cash_ok') then 'confirmed'
  when status = 'cancelled' then 'cancelled'
  when status = 'expired' then 'expired'
  else 'pending'
end
where booking_status is null;

-- payment_mode
update bookings
set payment_mode = case
  when source = 'event' and checkout_hold_expires_at is not null then 'pay_now'
  when source = 'event' and payment_due_at is not null then 'pay_later'
  when source = 'event' then 'free'
  when source = 'session' and session_type = 'intro' then 'free'
  when source = 'session' and checkout_hold_expires_at is not null then 'pay_now'
  when source = 'session' and payment_due_at is not null then 'pay_later'
  else 'pay_later'
end
where payment_mode is null;

-- payment_status_v2
update bookings
set payment_status_v2 = case
  when payment_mode = 'free' then 'not_required'
  when payment_mode = 'pay_now' and booking_status = 'confirmed' then 'paid'
  when payment_mode = 'pay_now' then 'pending'
  when payment_mode = 'pay_later' and booking_status = 'confirmed' then 'pending'
  else 'pending'
end
where payment_status_v2 is null;

-- email_status
update bookings
set email_status = case
  when payment_mode = 'pay_now' then 'not_required'
  when status = 'pending_email' then 'pending_confirmation'
  when status = 'expired' then 'expired'
  else 'confirmed'
end
where email_status is null;

-- calendar_status (sessions only)
update bookings
set calendar_status = case
  when source = 'session' and google_event_id is not null then 'created'
  when source = 'session' and (status in ('confirmed','cash_ok') or payment_due_at is not null) then 'pending'
  else 'not_required'
end
where calendar_status is null;

-- slot_status
update bookings
set slot_status = case
  when booking_status = 'confirmed' then 'reserved'
  when checkout_hold_expires_at is not null and checkout_hold_expires_at > now() then 'reserved'
  else 'released'
end
where slot_status is null;

-- New audit trail: booking_events
create table if not exists booking_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  event_type text not null,
  source text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_booking_events_booking on booking_events(booking_id, created_at desc);

-- Optional outbox: booking_side_effects
create table if not exists booking_side_effects (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  effect_type text not null,
  status text not null check (status in ('pending','processing','done','failed')),
  payload jsonb not null default '{}'::jsonb,
  error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_booking_side_effects_status on booking_side_effects(status, created_at desc);
