-- pa_undo_log: holds up to 500 most-recent undoable actions per user.
-- Overflow rows are moved to pa_undo_log_history on each GET /api/undo fetch.
create table if not exists pa_undo_log (
  id          text        primary key,
  user_id     text        not null,
  label       text        not null,
  snapshots   jsonb       not null,  -- array of UndoSnapshot (see undoRepo.ts)
  created_at  timestamptz not null default now()
);

create index if not exists idx_pa_undo_log_user
  on pa_undo_log(user_id, created_at desc);

-- pa_undo_log_history: archive of rows that fell off the 500-row cap.
-- Never trimmed automatically; clean up manually whenever needed.
create table if not exists pa_undo_log_history (
  id          text        primary key,
  user_id     text        not null,
  label       text        not null,
  snapshots   jsonb       not null,
  created_at  timestamptz not null,
  archived_at timestamptz not null default now()
);

create index if not exists idx_pa_undo_log_history_user
  on pa_undo_log_history(user_id, created_at desc);
