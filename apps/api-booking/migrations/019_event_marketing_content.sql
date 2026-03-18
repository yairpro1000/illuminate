alter table public.events
add column if not exists marketing_content jsonb not null default '{}'::jsonb;
