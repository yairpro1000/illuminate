alter table public.payments
  add column if not exists refund_status text,
  add column if not exists refund_amount numeric(10, 2),
  add column if not exists refund_currency text,
  add column if not exists stripe_refund_id text,
  add column if not exists stripe_credit_note_id text,
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_reason text;

update public.payments
set refund_status = 'NONE'
where refund_status is null;

alter table public.payments
  alter column refund_status set default 'NONE';

do $$
begin
  alter table public.payments
    add constraint payments_refund_status_check
    check (refund_status in ('NONE', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED'));
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_payments_stripe_refund_id
  on public.payments using btree (stripe_refund_id);

create index if not exists idx_payments_stripe_credit_note_id
  on public.payments using btree (stripe_credit_note_id);
