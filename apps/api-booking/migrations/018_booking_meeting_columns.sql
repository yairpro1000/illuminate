-- Capture the already-applied booking meeting columns in repository history.
-- Safe to run on environments where the columns may already exist.

alter table public.bookings
  add column if not exists meeting_provider text null,
  add column if not exists meeting_link text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bookings_meeting_provider_check'
  ) then
    alter table public.bookings
      add constraint bookings_meeting_provider_check
      check (meeting_provider in ('google_meet', 'zoom'));
  end if;
end $$;
