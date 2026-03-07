-- Migration 005: Fix multi-user primary key constraints for PA tables
--
-- Problem: pa_lists has list_id as its sole primary key, so two users cannot
-- have a list with the same name (e.g. "translate"). The unique/FK constraints
-- on child tables have the same gap.
--
-- Fix:
--   1. Change pa_lists PK from (list_id) → (user_id, list_id)
--   2. Update FK constraints on child tables to reference the composite PK
--   3. Update unique constraints on child tables to include user_id

-- ── Step 1: drop FKs on child tables that reference pa_lists(list_id) ────────
ALTER TABLE pa_list_aliases       DROP CONSTRAINT IF EXISTS pa_list_aliases_list_id_fkey;
ALTER TABLE pa_list_custom_fields DROP CONSTRAINT IF EXISTS pa_list_custom_fields_list_id_fkey;
ALTER TABLE pa_list_items         DROP CONSTRAINT IF EXISTS pa_list_items_list_id_fkey;

-- ── Step 2: drop unique constraints that are missing user_id ─────────────────
ALTER TABLE pa_list_aliases       DROP CONSTRAINT IF EXISTS pa_list_aliases_list_id_alias_key;
ALTER TABLE pa_list_custom_fields DROP CONSTRAINT IF EXISTS pa_list_custom_fields_list_id_name_key;

-- ── Step 3: replace pa_lists primary key ────────────────────────────────────
ALTER TABLE pa_lists DROP CONSTRAINT pa_lists_pkey;
ALTER TABLE pa_lists ADD PRIMARY KEY (user_id, list_id);

-- ── Step 4: re-add FKs on child tables referencing the composite PK ──────────
ALTER TABLE pa_list_aliases
  ADD CONSTRAINT pa_list_aliases_user_list_fkey
  FOREIGN KEY (user_id, list_id) REFERENCES pa_lists(user_id, list_id) ON DELETE CASCADE;

ALTER TABLE pa_list_custom_fields
  ADD CONSTRAINT pa_list_custom_fields_user_list_fkey
  FOREIGN KEY (user_id, list_id) REFERENCES pa_lists(user_id, list_id) ON DELETE CASCADE;

ALTER TABLE pa_list_items
  ADD CONSTRAINT pa_list_items_user_list_fkey
  FOREIGN KEY (user_id, list_id) REFERENCES pa_lists(user_id, list_id) ON DELETE CASCADE;

-- ── Step 5: re-add unique constraints with user_id included ──────────────────
ALTER TABLE pa_list_aliases
  ADD CONSTRAINT pa_list_aliases_user_list_alias_key
  UNIQUE (user_id, list_id, alias);

ALTER TABLE pa_list_custom_fields
  ADD CONSTRAINT pa_list_custom_fields_user_list_name_key
  UNIQUE (user_id, list_id, name);
