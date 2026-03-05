function ddl() {
  return `
-- PA lean V1 schema (manual DDL)
-- Paste into Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists pa_lists (
  list_id text primary key,
  title text not null,
  description text null,
  ui_default_sort text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pa_list_aliases (
  id uuid primary key default gen_random_uuid(),
  list_id text not null references pa_lists(list_id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  unique (list_id, alias)
);

create table if not exists pa_list_fields (
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
`.trimStart();
}

process.stdout.write(ddl());

