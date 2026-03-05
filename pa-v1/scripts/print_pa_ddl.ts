function ddl() {
  return `
create extension if not exists "pgcrypto";

create table if not exists pa_lists (
  list_id text primary key,
  title text not null,
  description text null,
  ui_default_sort text null,
  items_revision bigint not null default 0,
  items_updated_at timestamptz not null default now(),
  items_updated_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Backfill / upgrades for existing tables (safe to re-run)
alter table pa_lists add column if not exists items_revision bigint not null default 0;
alter table pa_lists add column if not exists items_updated_at timestamptz not null default now();
alter table pa_lists add column if not exists items_updated_by text null;

create table if not exists pa_list_aliases (
  id uuid primary key default gen_random_uuid(),
  list_id text not null references pa_lists(list_id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  unique (list_id, alias)
);

-- Normalize schema fields:
-- - base fields are shared by all lists
-- - custom fields are list-specific and stored once per list
create table if not exists pa_base_fields (
  name text primary key,
  type text not null,
  default_value_json jsonb null,
  nullable boolean not null default false,
  description text null,
  ui_show_in_preview boolean null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Migration: older schemas used 'pa_list_fields' for both base + custom.
do $$
begin
  if to_regclass('public.pa_list_custom_fields') is null and to_regclass('public.pa_list_fields') is not null then
    alter table public.pa_list_fields rename to pa_list_custom_fields;
  end if;
end $$;

create table if not exists pa_list_custom_fields (
  id uuid primary key default gen_random_uuid(),
  list_id text not null references pa_lists(list_id) on delete cascade,
  name text not null,
  type text not null,
  default_value_json jsonb null,
  nullable boolean not null default false,
  description text null,
  ui_show_in_preview boolean null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (list_id, name)
);

-- Ensure base fields exist (safe to re-run)
insert into pa_base_fields (name, type, default_value_json, nullable, description, ui_show_in_preview)
values
  ('text',         'string', null,              false, null, null),
  ('priority',     'int',    to_jsonb(3),       false, null, null),
  ('color',        'string', null,              true,  null, null),
  ('order',        'int',    to_jsonb(0),       false, null, null),
  ('status',       'string', to_jsonb('todo'::text), false, null, null),
  ('archivedAt',   'date',   null,              true,  null, null),
  ('unarchivedAt', 'date',   null,              true,  null, null)
on conflict (name) do update
set type = excluded.type,
    default_value_json = excluded.default_value_json,
    nullable = excluded.nullable,
    description = excluded.description,
    ui_show_in_preview = excluded.ui_show_in_preview,
    updated_at = now();

-- If we migrated from the old duplicated table, remove base field duplicates from the custom table.
delete from pa_list_custom_fields
where name in ('text','priority','color','order','status','archivedAt','unarchivedAt');

create table if not exists pa_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id text not null references pa_lists(list_id) on delete cascade,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  text text not null,
  priority integer not null default 3,
  color text null,
  status text not null default 'todo',
  "order" integer not null default 0,

  archived_at timestamptz null,
  unarchived_at timestamptz null,

  extra_fields jsonb not null default '{}'::jsonb
);

create index if not exists idx_pa_list_items_list_priority_order on pa_list_items(list_id, priority, "order");
create index if not exists idx_pa_list_items_list_created_at on pa_list_items(list_id, created_at desc);
create index if not exists idx_pa_list_items_list_archived_at on pa_list_items(list_id, archived_at);

-- List "touch" (bump revision after any write)
create or replace function pa_touch_list(
  p_list_id text,
  p_updated_by text
) returns bigint
language plpgsql
as $$
declare
  v_next bigint;
begin
  update pa_lists
  set items_revision = items_revision + 1,
      items_updated_at = now(),
      items_updated_by = p_updated_by
  where list_id = p_list_id
  returning items_revision into v_next;

  if v_next is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  return v_next;
end;
$$;

-- Atomic reorder + optimistic concurrency (list-level)
create or replace function pa_reorder_bucket(
  p_list_id text,
  p_priority integer,
  p_ordered_ids uuid[],
  p_expected_revision bigint,
  p_updated_by text
) returns bigint
language plpgsql
as $$
declare
  v_current bigint;
  v_updated int;
  v_next bigint;
begin
  select items_revision into v_current
  from pa_lists
  where list_id = p_list_id
  for update;

  if v_current is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if v_current <> p_expected_revision then
    raise exception 'conflict' using errcode = 'P0001', detail = json_build_object('current', v_current)::text;
  end if;

  update pa_list_items i
  set "order" = u.ord - 1,
      updated_at = now()
  from unnest(p_ordered_ids) with ordinality as u(id, ord)
  where i.id = u.id
    and i.list_id = p_list_id
    and i.priority = p_priority;

  get diagnostics v_updated = row_count;
  if v_updated <> coalesce(array_length(p_ordered_ids, 1), 0) then
    raise exception 'bad_request' using errcode = 'P0001', detail = json_build_object('updated', v_updated)::text;
  end if;

  update pa_lists
  set items_revision = items_revision + 1,
      items_updated_at = now(),
      items_updated_by = p_updated_by
  where list_id = p_list_id
  returning items_revision into v_next;

  return v_next;
end;
$$;
`.trimStart();
}

process.stdout.write(ddl());
