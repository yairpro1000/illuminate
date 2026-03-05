# PA Database Schema (Lean V1)

Goal: replace the current file-based PA storage with a **lean relational schema** in Supabase Postgres, while keeping PA V1 behavior:

- Schema registry source (current): `pa-v1/data/meta/lists.schema.json`
- Items source (current): `pa-v1/data/lists/<listId>.jsonl` (1 JSON object per line)

PA tables are prefixed `pa_`.

## DDL source of truth

Generate the full DDL (copy/paste into Supabase SQL editor):

- `cd pa-v1 && npm run print-ddl`

## Tables (current)

### `pa_lists` (list metadata + concurrency)

- `list_id` (PK)
- `title`
- `description`
- `ui_default_sort`
- `items_revision` (bigint, starts at 0)
- `items_updated_at` (timestamptz)
- `items_updated_by` (text, `${email}_${deviceId}`)
- `created_at`
- `updated_at`

### `pa_list_aliases` (list name aliases)

- `id` (uuid PK)
- `list_id` (FK → `pa_lists.list_id`)
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

### `pa_list_custom_fields` (list-specific schema fields)

- `id` (uuid PK)
- `list_id` (FK → `pa_lists.list_id`)
- `name`
- `type`
- `default_value_json` (jsonb)
- `nullable`
- `description`
- `ui_show_in_preview`
- `created_at`
- `updated_at`

### `pa_list_items` (items / rows)

Universal columns (exist for all lists):
- `id` (uuid PK)
- `list_id` (FK → `pa_lists.list_id`)
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

## Indexes (minimum)

The DDL includes indexes to keep list browsing and sorting fast, including:

- `(list_id, priority, order)` for bucket ordering
- `(list_id, created_at desc)`
- `(list_id, archived_at)`

## Concurrency (why `items_revision` exists)

PA V1 assumes a single user across multiple devices (laptop + phone). To prevent two devices from overwriting each other:

- Item edits use **optimistic concurrency** via `pa_list_items.updated_at`.
- Reorder uses **list-level optimistic concurrency** via `pa_lists.items_revision`.

### DB functions (required)

The DDL defines two functions used by the Worker API:

- `pa_touch_list(list_id, updated_by)`:
  - increments `items_revision`
  - updates `items_updated_at/items_updated_by`
- `pa_reorder_bucket(list_id, priority, ordered_ids, expected_revision, updated_by)`:
  - locks the list row
  - verifies `expected_revision`
  - updates all `order` values in one atomic statement
  - increments `items_revision` (and updates `items_updated_*`)
