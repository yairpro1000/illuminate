alter table public.payments
  add column if not exists stripe_receipt_url text,
  add column if not exists stripe_credit_note_url text;
