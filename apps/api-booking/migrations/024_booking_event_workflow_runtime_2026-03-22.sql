alter table public.booking_events
  add column if not exists status text;

alter table public.booking_events
  add column if not exists error_message text;

alter table public.booking_events
  add column if not exists completed_at timestamp with time zone;

alter table public.booking_events
  add column if not exists updated_at timestamp with time zone not null default now();

update public.booking_events
set status = 'SUCCESS'
where status is null;

alter table public.booking_events
  alter column status set not null;

alter table public.booking_events
  drop constraint if exists booking_events_status_check;

alter table public.booking_events
  add constraint booking_events_status_check
  check (status = any (array['PENDING'::text, 'PROCESSING'::text, 'SUCCESS'::text, 'FAILED'::text]));

alter table public.booking_side_effect_attempts
  add column if not exists updated_at timestamp with time zone not null default now();

alter table public.booking_side_effect_attempts
  add column if not exists completed_at timestamp with time zone;

alter table public.booking_side_effect_attempts
  drop constraint if exists booking_side_effect_attempts_status_check;

alter table public.booking_side_effect_attempts
  add constraint booking_side_effect_attempts_status_check
  check (status = any (array['PROCESSING'::text, 'SUCCESS'::text, 'FAILED'::text]));
