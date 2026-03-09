-- Session types table and event image metadata

create extension if not exists "pgcrypto";

-- Enum for session type status
DO $$ BEGIN
  CREATE TYPE session_type_status AS ENUM ('draft', 'active', 'hidden');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- session_types table
create table if not exists session_types (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  short_description text null,
  description text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  price integer not null check (price >= 0), -- cents
  currency text not null default 'CHF',
  status session_type_status not null default 'draft',
  sort_order integer not null default 0,
  image_key text null,
  drive_file_id text null,
  image_alt text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure columns exist with defaults if migrating an existing table
alter table session_types
  add column if not exists title text,
  add column if not exists slug text,
  add column if not exists short_description text,
  add column if not exists description text,
  add column if not exists duration_minutes integer,
  add column if not exists price integer,
  add column if not exists currency text not null default 'CHF',
  add column if not exists status session_type_status not null default 'draft',
  add column if not exists sort_order integer not null default 0,
  add column if not exists image_key text,
  add column if not exists drive_file_id text,
  add column if not exists image_alt text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Add simple indexes for public reads
create index if not exists idx_session_types_active_order on session_types(status, sort_order, created_at);

-- Extend events table with image metadata
alter table events
  add column if not exists image_key text,
  add column if not exists drive_file_id text,
  add column if not exists image_alt text;
