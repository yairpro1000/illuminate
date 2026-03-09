-- Remove stale logging schema remnants from earlier job-run tracking.
-- Safe to run multiple times.

alter table if exists failure_logs
  drop column if exists job_run_id;
