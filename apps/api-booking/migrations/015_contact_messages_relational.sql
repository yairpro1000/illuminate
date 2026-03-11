-- Rebuild contact_messages as relational-only (client_id + message metadata).
-- Removes duplicated first_name/last_name/email columns.

begin;

alter table if exists contact_messages
  rename to contact_messages_legacy_015;

create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  topic text null,
  message text not null,
  status contact_message_status not null default 'new',
  source text not null default 'website_contact_form',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into contact_messages (id, client_id, topic, message, status, source, created_at, updated_at)
select
  l.id,
  l.client_id,
  l.topic,
  l.message,
  l.status,
  l.source,
  l.created_at,
  l.updated_at
from contact_messages_legacy_015 l
where l.client_id is not null
on conflict (id) do nothing;

drop index if exists idx_contact_messages_status_created;
drop index if exists idx_contact_messages_email;
drop index if exists idx_contact_messages_client_id;

create index if not exists idx_contact_messages_status_created
  on contact_messages(status, created_at desc);
create index if not exists idx_contact_messages_client_id
  on contact_messages(client_id);

drop trigger if exists trg_contact_messages_updated_at on contact_messages_legacy_015;
drop trigger if exists trg_contact_messages_updated_at on contact_messages;
create trigger trg_contact_messages_updated_at
before update on contact_messages
for each row execute function set_updated_at();

drop table if exists contact_messages_legacy_015;

commit;
