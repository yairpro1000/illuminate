create table public.system_settings (
  domain text not null,
  keyname text primary key,
  readable_name text not null,

  value_type text not null check (
    value_type in (
      'integer',
      'float',
      'boolean',
      'text',
      'json'
    )
  ),

  unit text null,
  value text not null,

  description text not null,
  description_he text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index idx_system_settings_domain_keyname
on public.system_settings (domain, keyname);