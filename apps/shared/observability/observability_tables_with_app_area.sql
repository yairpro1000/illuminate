-- Recreate observability tables with app_area added

begin;


create table public.exception_logs (
  id uuid not null default gen_random_uuid (),
  created_at timestamp with time zone not null default now(),
  app_area text not null,
  request_id text not null,
  correlation_id text not null,
  booking_id uuid null,
  booking_event_id uuid null,
  side_effect_id uuid null,
  side_effect_attempt_id uuid null,
  error_type text not null,
  error_code text null,
  message text not null,
  stack_trace text null,
  context_json jsonb null,
  constraint exception_logs_pkey primary key (id),
  constraint exception_logs_app_area_check check (
    app_area = any (array['website'::text, 'admin'::text, 'pa'::text])
  ),
  constraint exception_logs_booking_event_id_fkey foreign key (booking_event_id) references booking_events (id) on delete set null,
  constraint exception_logs_booking_id_fkey foreign key (booking_id) references bookings (id) on delete set null,
  constraint exception_logs_side_effect_attempt_id_fkey foreign key (side_effect_attempt_id) references booking_side_effect_attempts (id) on delete set null,
  constraint exception_logs_side_effect_id_fkey foreign key (side_effect_id) references booking_side_effects (id) on delete set null
) TABLESPACE pg_default;

create index if not exists idx_exception_logs_created_at on public.exception_logs using btree (created_at desc) TABLESPACE pg_default;
create index if not exists idx_exception_logs_app_area_created_at on public.exception_logs using btree (app_area, created_at desc) TABLESPACE pg_default;
create index if not exists idx_exception_logs_request_id on public.exception_logs using btree (request_id) TABLESPACE pg_default;
create index if not exists idx_exception_logs_correlation_id on public.exception_logs using btree (correlation_id) TABLESPACE pg_default;
create index if not exists idx_exception_logs_booking_id_created_at on public.exception_logs using btree (booking_id, created_at desc) TABLESPACE pg_default;
create index if not exists idx_exception_logs_booking_event_id_created_at on public.exception_logs using btree (booking_event_id, created_at desc) TABLESPACE pg_default;
create index if not exists idx_exception_logs_side_effect_id_created_at on public.exception_logs using btree (side_effect_id, created_at desc) TABLESPACE pg_default;
create index if not exists idx_exception_logs_side_effect_attempt_id_created_at on public.exception_logs using btree (side_effect_attempt_id, created_at desc) TABLESPACE pg_default;
create index if not exists idx_exception_logs_error_type_created_at on public.exception_logs using btree (error_type, created_at desc) TABLESPACE pg_default;
create index if not exists idx_exception_logs_error_code_created_at on public.exception_logs using btree (error_code, created_at desc) TABLESPACE pg_default
where (error_code is not null);

create table public.api_logs (
  id uuid not null default gen_random_uuid (),
  created_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone null,
  app_area text not null,
  request_id text not null,
  correlation_id text not null,
  booking_id uuid null,
  booking_event_id uuid null,
  side_effect_id uuid null,
  side_effect_attempt_id uuid null,
  direction text not null,
  provider text null,
  method text not null,
  url text not null,
  request_headers_redacted jsonb null,
  request_body_preview jsonb null,
  response_status integer null,
  response_headers_redacted jsonb null,
  response_body_preview jsonb null,
  duration_ms integer null,
  error_code text null,
  error_message text null,
  constraint api_logs_pkey primary key (id),
  constraint api_logs_app_area_check check (
    app_area = any (array['website'::text, 'admin'::text, 'pa'::text])
  ),
  constraint api_logs_side_effect_attempt_id_fkey foreign key (side_effect_attempt_id) references booking_side_effect_attempts (id) on delete set null,
  constraint api_logs_side_effect_id_fkey foreign key (side_effect_id) references booking_side_effects (id) on delete set null,
  constraint api_logs_booking_id_fkey foreign key (booking_id) references bookings (id) on delete set null,
  constraint api_logs_booking_event_id_fkey foreign key (booking_event_id) references booking_events (id) on delete set null,
  constraint api_logs_duration_ms_check check (
    (duration_ms is null) or (duration_ms >= 0)
  ),
  constraint api_logs_direction_check check (
    direction = any (array['inbound'::text, 'outbound'::text])
  )
) TABLESPACE pg_default;

create index if not exists idx_api_logs_created_at on public.api_logs using btree (created_at desc) TABLESPACE pg_default;
create index if not exists idx_api_logs_app_area_created_at on public.api_logs using btree (app_area, created_at desc) TABLESPACE pg_default;
create index if not exists idx_api_logs_request_id on public.api_logs using btree (request_id) TABLESPACE pg_default;
create index if not exists idx_api_logs_correlation_id on public.api_logs using btree (correlation_id) TABLESPACE pg_default;
create index if not exists idx_api_logs_booking_id_created_at on public.api_logs using btree (booking_id, created_at desc) TABLESPACE pg_default;
create index if not exists idx_api_logs_booking_event_id_created_at on public.api_logs using btree (booking_event_id, created_at desc) TABLESPACE pg_default;
create index if not exists idx_api_logs_side_effect_id_created_at on public.api_logs using btree (side_effect_id, created_at desc) TABLESPACE pg_default;
create index if not exists idx_api_logs_side_effect_attempt_id_created_at on public.api_logs using btree (side_effect_attempt_id, created_at desc) TABLESPACE pg_default;
create index if not exists idx_api_logs_direction_created_at on public.api_logs using btree (direction, created_at desc) TABLESPACE pg_default;
create index if not exists idx_api_logs_provider_created_at on public.api_logs using btree (provider, created_at desc) TABLESPACE pg_default
where (provider is not null);
create index if not exists idx_api_logs_response_status_created_at on public.api_logs using btree (response_status, created_at desc) TABLESPACE pg_default
where (response_status is not null);
create index if not exists idx_api_logs_error_code_created_at on public.api_logs using btree (error_code, created_at desc) TABLESPACE pg_default
where (error_code is not null);

commit;
