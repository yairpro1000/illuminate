alter table public.payments
  add column if not exists stripe_customer_id text null,
  add column if not exists stripe_checkout_session_id text null,
  add column if not exists stripe_payment_intent_id text null,
  add column if not exists stripe_invoice_id text null,
  add column if not exists stripe_payment_link_id text null;

alter table public.payments
  drop column if exists provider_payment_id;

drop index if exists public.idx_payments_provider_payment;

create index if not exists idx_payments_stripe_checkout_session_id
  on public.payments using btree (stripe_checkout_session_id);

create index if not exists idx_payments_stripe_payment_intent_id
  on public.payments using btree (stripe_payment_intent_id);

create index if not exists idx_payments_stripe_invoice_id
  on public.payments using btree (stripe_invoice_id);

create index if not exists idx_payments_stripe_payment_link_id
  on public.payments using btree (stripe_payment_link_id);
