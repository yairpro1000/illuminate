-- Calendar sync retry queue optimization (uses existing failure_logs table)
-- Safe to run multiple times.

create index if not exists idx_failure_logs_calendar_sync_due
  on failure_logs(next_retry_at, booking_id)
  where source = 'calendar'
    and operation = 'calendar_sync'
    and retryable = true
    and resolved_at is null
    and next_retry_at is not null;

create unique index if not exists idx_failure_logs_calendar_sync_active_unique
  on failure_logs(booking_id)
  where source = 'calendar'
    and operation = 'calendar_sync'
    and resolved_at is null;
