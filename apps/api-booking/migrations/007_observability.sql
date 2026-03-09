-- Shared observability schema for backend + worker + frontend-forwarded events.
-- Safe to run multiple times where possible.

create extension if not exists "pgcrypto";

create schema if not exists observability;

revoke all on schema observability from public;
grant usage on schema observability to postgres, service_role;
revoke usage on schema observability from anon, authenticated;

create table if not exists observability.logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null check (source in ('frontend', 'backend', 'worker', 'cron', 'provider')),
  level text not null check (level in ('debug', 'info', 'warn', 'error', 'fatal')),
  event_type text not null,
  message text null,
  error_code text null,
  request_id text null,
  correlation_id text null,
  user_id uuid null,
  session_id text null,
  route text null,
  context jsonb not null default '{}'::jsonb
);

create table if not exists observability.api_logs (
  id uuid primary key default gen_random_uuid(),
  log_id uuid not null unique references observability.logs(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  provider text null,
  method text null,
  url text null,
  path text null,
  status_code integer null,
  duration_ms integer null,
  success boolean not null default true,
  retry_count integer not null default 0,
  request_size_bytes integer null,
  response_size_bytes integer null
);

create table if not exists observability.api_failure_details (
  id uuid primary key default gen_random_uuid(),
  api_log_id uuid not null unique references observability.api_logs(id) on delete cascade,
  request_headers jsonb null,
  request_body jsonb null,
  response_headers jsonb null,
  response_body jsonb null,
  provider_error text null,
  stack_trace text null,
  redaction_note text null
);

create table if not exists observability.error_details (
  id uuid primary key default gen_random_uuid(),
  log_id uuid not null unique references observability.logs(id) on delete cascade,
  error_name text null,
  stack_trace text null,
  component text null,
  runtime text null,
  browser text null,
  file text null,
  function_name text null,
  line_number integer null,
  column_number integer null,
  extra jsonb not null default '{}'::jsonb
);

comment on schema observability is 'Internal observability tables for short-term debugging across products.';
comment on table observability.logs is 'Generic event table for request lifecycle, business milestones, and exception events.';
comment on table observability.api_logs is 'Lean request/provider lifecycle facts linked 1:1 to observability.logs.';
comment on table observability.api_failure_details is 'Failure-only request/response previews with redacted and truncated payloads.';
comment on table observability.error_details is 'Runtime exception metadata for frontend, backend, and worker failures.';
comment on column observability.logs.context is 'Compact structured context. Temporary business-flow milestones should set context.temporary_debug=true.';
comment on column observability.api_failure_details.redaction_note is 'Documents secret stripping and preview truncation rules applied before storage.';

create index if not exists idx_observability_logs_created_at_desc on observability.logs (created_at desc);
create index if not exists idx_observability_logs_event_type on observability.logs (event_type);
create index if not exists idx_observability_logs_level on observability.logs (level);
create index if not exists idx_observability_logs_request_id on observability.logs (request_id);
create index if not exists idx_observability_logs_correlation_id on observability.logs (correlation_id);
create index if not exists idx_observability_logs_user_id on observability.logs (user_id);
create index if not exists idx_observability_logs_booking_id on observability.logs ((context ->> 'booking_id'));
drop index if exists observability.idx_observability_logs_registration_id;

create index if not exists idx_observability_api_logs_provider on observability.api_logs (provider);
create index if not exists idx_observability_api_logs_status_code on observability.api_logs (status_code);
create index if not exists idx_observability_api_logs_success on observability.api_logs (success);

alter table observability.logs enable row level security;
alter table observability.api_logs enable row level security;
alter table observability.api_failure_details enable row level security;
alter table observability.error_details enable row level security;

drop policy if exists observability_logs_service_role on observability.logs;
create policy observability_logs_service_role
  on observability.logs
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists observability_api_logs_service_role on observability.api_logs;
create policy observability_api_logs_service_role
  on observability.api_logs
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists observability_api_failure_details_service_role on observability.api_failure_details;
create policy observability_api_failure_details_service_role
  on observability.api_failure_details
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists observability_error_details_service_role on observability.error_details;
create policy observability_error_details_service_role
  on observability.error_details
  for all
  to service_role
  using (true)
  with check (true);

revoke all on all tables in schema observability from anon, authenticated;
grant select, insert, update, delete on all tables in schema observability to service_role;

create or replace function observability.cleanup_retention(
  general_keep interval default interval '30 days',
  detail_keep interval default interval '30 days'
)
returns jsonb
language plpgsql
security definer
set search_path = observability, public
as $$
declare
  deleted_logs integer := 0;
  deleted_api_failure_details integer := 0;
  deleted_error_details integer := 0;
begin
  delete from observability.api_failure_details afd
  using observability.api_logs al
  join observability.logs l on l.id = al.log_id
  where afd.api_log_id = al.id
    and l.created_at < now() - detail_keep;
  get diagnostics deleted_api_failure_details = row_count;

  delete from observability.error_details ed
  using observability.logs l
  where ed.log_id = l.id
    and l.created_at < now() - detail_keep;
  get diagnostics deleted_error_details = row_count;

  delete from observability.logs
  where created_at < now() - general_keep;
  get diagnostics deleted_logs = row_count;

  return jsonb_build_object(
    'deleted_logs', deleted_logs,
    'deleted_api_failure_details', deleted_api_failure_details,
    'deleted_error_details', deleted_error_details,
    'general_keep', general_keep::text,
    'detail_keep', detail_keep::text
  );
end;
$$;

revoke execute on function observability.cleanup_retention(interval, interval) from public, anon, authenticated;
grant execute on function observability.cleanup_retention(interval, interval) to service_role;

comment on function observability.cleanup_retention(interval, interval) is
  'Deletes base logs older than 30 days by default. Detail rows follow base-row retention because of cascading foreign keys.';

-- Manual cleanup examples:
-- select observability.cleanup_retention();
-- select observability.cleanup_retention(interval '30 days', interval '90 days');
