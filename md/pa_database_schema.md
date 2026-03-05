# PA Database Schema (Lean V1)

Goal: a minimal schema that can replace the current file-based storage:

- Schema registry: `pa-v1/data/meta/lists.schema.json`
- List items: `pa-v1/data/lists/<listId>.jsonl` (1 JSON object per line)

## Tables (proposed)

### `pa_lists`

- `list_id`
- `title`
- `description`
- `ui_default_sort`
- `created_at`
- `updated_at`

### `pa_list_aliases`

- `id`
- `list_id`
- `alias`

### `pa_list_fields`

- `id`
- `list_id`
- `name`
- `type`
- `default_value_json`
- `nullable`
- `description`
- `created_at`
- `updated_at`

### `pa_list_items`

- `id`
- `list_id`
- `created_at`
- `updated_at`
- `priority`
- `color`
- `status`
- `archived_at`
- `unarchived_at`

### `pa_list_item_fields`

- `id`
- `item_id`
- `field_id`
- `value_string`
- `value_int`
- `value_timestamptz`
- `value_json`
- `updated_at`
