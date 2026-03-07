# PA Database Schema (Lean V1)

Goal: replace the current file-based PA storage with a **lean relational schema** in Supabase Postgres, while keeping PA V1 behavior:

- Schema registry source (current): `data/pa/meta/lists.schema.json`
- Items source (current): `data/pa/lists/<listId>.jsonl` (1 JSON object per line)

PA tables are prefixed `pa_`.

## Multi-user ownership (PA V1 → multi-user)

PA is now **multi-user**. Every user-owned row includes:

- `user_id UUID NOT NULL REFERENCES auth.users(id)`

**User-owned tables**

- `pa_lists` (a list belongs to a user)
- `pa_list_aliases` (belongs to a list + user)
- `pa_list_custom_fields` (belongs to a list + user)
- `pa_list_items` (belongs to a list + user)
- `pa_undo_log` / `pa_undo_log_history` (belongs to a user)

**Global/reference tables**

- `pa_base_fields` (shared base schema; not user-owned)

Ownership chain (enforced by app queries + FKs):

- List → user
- Alias/custom-field/item → list → user (and also stores `user_id` directly for fast/scoped queries)

## DDL source of truth

The DDL is captured in this doc; copy/paste into Supabase SQL editor.

## DDL (create all PA tables + RPCs)

```sql
-- PA (Lean V1) schema
-- Notes:
-- - Uses jsonb for custom per-list fields (pa_list_items.extra_fields)
-- - Uses 2 RPC functions: pa_touch_list + pa_reorder_bucket
-- - All user-owned tables include `user_id uuid not null references auth.users(id)`

-- UUID helper (Supabase typically enables this already)
create extension if not exists pgcrypto;

-- Generic updated_at trigger
create or replace function pa_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Lists
create table if not exists pa_lists (
  list_id text primary key,
  user_id uuid not null references auth.users(id),
  title text not null,
  description text null,
  ui_default_sort text null,
  items_revision bigint not null default 0,
  items_updated_at timestamptz not null default now(),
  items_updated_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists pa_lists_set_updated_at on pa_lists;
create trigger pa_lists_set_updated_at
before update on pa_lists
for each row execute function pa_set_updated_at();

-- Aliases
create table if not exists pa_list_aliases (
  id uuid primary key default gen_random_uuid(),
  list_id text not null references pa_lists(list_id) on delete cascade,
  user_id uuid not null references auth.users(id),
  alias text not null,
  created_at timestamptz not null default now(),
  unique(list_id, alias)
);

create index if not exists pa_list_aliases_user_list_id_idx on pa_list_aliases(user_id, list_id);
create index if not exists pa_list_aliases_alias_idx on pa_list_aliases(alias);

-- Base fields (shared schema)
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

drop trigger if exists pa_base_fields_set_updated_at on pa_base_fields;
create trigger pa_base_fields_set_updated_at
before update on pa_base_fields
for each row execute function pa_set_updated_at();

-- Custom fields (per-list schema)
create table if not exists pa_list_custom_fields (
  id uuid primary key default gen_random_uuid(),
  list_id text not null references pa_lists(list_id) on delete cascade,
  user_id uuid not null references auth.users(id),
  name text not null,
  type text not null,
  default_value_json jsonb null,
  nullable boolean not null default false,
  description text null,
  ui_show_in_preview boolean null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(list_id, name)
);

drop trigger if exists pa_list_custom_fields_set_updated_at on pa_list_custom_fields;
create trigger pa_list_custom_fields_set_updated_at
before update on pa_list_custom_fields
for each row execute function pa_set_updated_at();

create index if not exists pa_list_custom_fields_user_list_id_idx on pa_list_custom_fields(user_id, list_id);

-- Items
create table if not exists pa_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id text not null references pa_lists(list_id) on delete cascade,
  user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  text text not null,
  priority int not null default 3,
  color text null,
  status text not null default 'todo',
  "order" bigint not null default 0,
  archived_at timestamptz null,
  unarchived_at timestamptz null,
  extra_fields jsonb not null default '{}'::jsonb
);

drop trigger if exists pa_list_items_set_updated_at on pa_list_items;
create trigger pa_list_items_set_updated_at
before update on pa_list_items
for each row execute function pa_set_updated_at();

create index if not exists pa_list_items_user_list_priority_order_idx on pa_list_items(user_id, list_id, priority, "order");
create index if not exists pa_list_items_user_list_created_at_desc_idx on pa_list_items(user_id, list_id, created_at desc);
create index if not exists pa_list_items_user_list_archived_at_idx on pa_list_items(user_id, list_id, archived_at);

-- Undo log (current)
create table if not exists pa_undo_log (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  label text not null,
  snapshots jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists pa_undo_log_user_created_at_desc_idx on pa_undo_log(user_id, created_at desc);

-- Undo log (history/overflow)
create table if not exists pa_undo_log_history (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  label text not null,
  snapshots jsonb not null,
  created_at timestamptz not null
);

create index if not exists pa_undo_log_history_user_created_at_desc_idx on pa_undo_log_history(user_id, created_at desc);

-- RPC: touch list (increments revision + timestamps)
create or replace function pa_touch_list(p_user_id uuid, p_list_id text, p_updated_by text)
returns bigint
language plpgsql
as $$
declare
  next_rev bigint;
begin
  update pa_lists
  set
    items_revision = items_revision + 1,
    items_updated_at = now(),
    items_updated_by = p_updated_by
  where user_id = p_user_id and list_id = p_list_id
  returning items_revision into next_rev;

  if next_rev is null then
    raise exception 'not_found' using detail = format('List "%s" not found.', p_list_id);
  end if;

  return next_rev;
end;
$$;

-- RPC: reorder a single priority bucket atomically with optimistic concurrency
create or replace function pa_reorder_bucket(
  p_user_id uuid,
  p_list_id text,
  p_priority int,
  p_ordered_ids uuid[],
  p_expected_revision bigint,
  p_updated_by text
)
returns bigint
language plpgsql
as $$
declare
  current_rev bigint;
  next_rev bigint;
begin
  if p_list_id is null or btrim(p_list_id) = '' then
    raise exception 'bad_request' using detail = 'Missing list_id.';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'bad_request' using detail = 'Missing/invalid expected_revision.';
  end if;

  -- Lock list row for revision check + atomic update
  select items_revision into current_rev
  from pa_lists
  where user_id = p_user_id and list_id = p_list_id
  for update;

  if current_rev is null then
    raise exception 'not_found' using detail = format('List "%s" not found.', p_list_id);
  end if;

  if current_rev <> p_expected_revision then
    raise exception 'conflict'
      using detail = json_build_object('current', current_rev)::text;
  end if;

  -- Apply order updates (1..N)
  with ord as (
    select unnest(p_ordered_ids) as id, generate_series(0, array_length(p_ordered_ids, 1) - 1) as idx
  )
  update pa_list_items it
  set "order" = ord.idx
  from ord
  where
    it.id = ord.id
    and it.user_id = p_user_id
    and it.list_id = p_list_id
    and it.priority = p_priority;

  -- bump revision
  update pa_lists
  set
    items_revision = items_revision + 1,
    items_updated_at = now(),
    items_updated_by = p_updated_by
  where user_id = p_user_id and list_id = p_list_id
  returning items_revision into next_rev;

  return next_rev;
end;
$$;
```

## Translate list (no new DDL required)

The translate feature does **not** require new tables/columns: it uses `pa_list_custom_fields` + `pa_list_items.extra_fields`.

If you want to pre-create the `translate` list via SQL (instead of letting the app auto-create it), here is a seed script:

```sql
-- Replace with the owning user's auth.users.id
-- (This doc uses `<user_uuid>` as a placeholder.)
insert into pa_lists (list_id, user_id, title, description, ui_default_sort)
values ('translate', '<user_uuid>', 'Translate', 'Translation entries', null)
on conflict (list_id) do nothing;

insert into pa_list_aliases (list_id, user_id, alias)
values
  ('translate', '<user_uuid>', 'translation'),
  ('translate', '<user_uuid>', 'translations')
on conflict (list_id, alias) do nothing;

insert into pa_list_custom_fields (list_id, user_id, name, type, default_value_json, nullable, description, ui_show_in_preview)
values
  ('translate', '<user_uuid>', 'originLanguage', 'string', null, true, 'Origin language (BCP-47)', true),
  ('translate', '<user_uuid>', 'originExpression', 'string', null, true, 'Origin expression', true),
  ('translate', '<user_uuid>', 'destinationLanguage', 'string', null, true, 'Destination language (BCP-47)', true),
  ('translate', '<user_uuid>', 'possibleTranslations', 'json', null, true, 'Possible translations', false),
  ('translate', '<user_uuid>', 'examplesOrigin', 'json', null, true, 'Examples in origin language', false),
  ('translate', '<user_uuid>', 'examplesDestination', 'json', null, true, 'Examples in destination language', false),
  ('translate', '<user_uuid>', 'comments', 'string', null, true, 'Comments', false)
on conflict (list_id, name) do nothing;
```

## Tables (current)

### `pa_lists` (user-owned list metadata + concurrency)

- `list_id` (PK)
- `user_id` (UUID FK → `auth.users.id`) — owner
- `title`
- `description`
- `ui_default_sort`
- `items_revision` (bigint, starts at 0)
- `items_updated_at` (timestamptz)
- `items_updated_by` (text, `${email}_${deviceId}`)
- `created_at`
- `updated_at`

### `pa_list_aliases` (user-owned list name aliases)

- `id` (uuid PK)
- `list_id` (FK → `pa_lists.list_id`)
- `user_id` (UUID FK → `auth.users.id`) — should match the owning list
- `alias`
- `created_at`

### `pa_base_fields` (shared schema fields)

Defines the **base fields** once (the fields that are fixed columns in `pa_list_items` and apply to every list).

- `name` (PK)
- `type`
- `default_value_json` (jsonb)
- `nullable`
- `description`
- `ui_show_in_preview`
- `created_at`
- `updated_at`

### `pa_list_custom_fields` (user-owned list-specific schema fields)

- `id` (uuid PK)
- `list_id` (FK → `pa_lists.list_id`)
- `user_id` (UUID FK → `auth.users.id`) — should match the owning list
- `name`
- `type`
- `default_value_json` (jsonb)
- `nullable`
- `description`
- `ui_show_in_preview`
- `created_at`
- `updated_at`

### `pa_list_items` (user-owned items / rows)

Universal columns (exist for all lists):
- `id` (uuid PK)
- `list_id` (FK → `pa_lists.list_id`)
- `user_id` (UUID FK → `auth.users.id`) — should match the owning list
- `created_at`
- `updated_at`
- `text`
- `priority`
- `color`
- `status`
- `order`
- `archived_at`
- `unarchived_at`

Custom per-list fields:
- `extra_fields` (jsonb) — stores non-universal fields

### `pa_undo_log` / `pa_undo_log_history` (user-owned undo stack)

- `id` (uuid PK)
- `user_id` (UUID FK → `auth.users.id`) — owner
- `label`
- `snapshots` (jsonb)
- `created_at`

## Indexes (minimum)

The DDL includes indexes to keep list browsing and sorting fast, including:

- `(user_id, list_id, priority, order)` for bucket ordering
- `(user_id, list_id, created_at desc)`
- `(user_id, list_id, archived_at)`

## Concurrency (why `items_revision` exists)

PA V1 assumes a single user across multiple devices (laptop + phone). To prevent two devices from overwriting each other:

- Item edits use **optimistic concurrency** via `pa_list_items.updated_at`.
- Reorder uses **list-level optimistic concurrency** via `pa_lists.items_revision`.

### DB functions (required)

The DDL defines two functions used by the Worker API:

- `pa_touch_list(user_id, list_id, updated_by)`:
  - increments `items_revision`
  - updates `items_updated_at/items_updated_by`
- `pa_reorder_bucket(user_id, list_id, priority, ordered_ids, expected_revision, updated_by)`:
  - locks the list row
  - verifies `expected_revision`
  - updates all `order` values in one atomic statement
  - increments `items_revision` (and updates `items_updated_*`)
