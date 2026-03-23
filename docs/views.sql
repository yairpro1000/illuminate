select 
-- * 
client_first_name, client_last_name, client_email,
booking_id, booking_session_type_id, starts_at, ends_at, booking_status, 
payment_amount, payment_status, 
booking_event_type, booking_event_status,
side_effect_intent, side_effect_status, 
side_effect_attempt_status, side_effect_attempt_created_at, side_effect_attempt_api_log_id
from public.booking_observability_big_view
where 
  -- starts_at >= '2026-03-30'
  -- and
  -- ends_at <= '2026-04-30'
  -- and
  -- booking_status = 'CONFIRMED'
  -- and
  booking_id = '1f741c1e-3383-47db-90f7-6608d6fc6df7'
order by 
  starts_at, side_effect_attempt_created_at




  -- drop view public.booking_observability_big_view;
-- create or replace view public.booking_observability_big_view_with_logs as
create or replace view public.booking_observability_big_view as
select
  c.id as client_id,
  c.first_name as client_first_name,
  c.last_name as client_last_name,
  c.email as client_email,
  c.phone as client_phone,

  b.id as booking_id,
  b.event_id as booking_parent_event_id,
  b.session_type_id as booking_session_type_id,
  b.booking_type,
  b.starts_at,
  b.ends_at,
  b.timezone as booking_timezone,
  b.google_event_id,
  b.address_line,
  b.maps_url,
  b.current_status as booking_status,
  b.notes as booking_notes,
  b.created_at as booking_created_at,
  b.updated_at as booking_updated_at,
  b.price as booking_price,
  b.currency as booking_currency,
  b.coupon_code,
  b.meeting_provider,
  b.meeting_link,

  p.id as payment_id,
  p.provider as payment_provider,
  p.amount as payment_amount,
  p.currency as payment_currency,
  p.status as payment_status,
  p.checkout_url,
  p.invoice_url,
  p.raw_payload as payment_raw_payload,
  p.paid_at,
  p.created_at as payment_created_at,
  p.updated_at as payment_updated_at,
  p.stripe_customer_id,
  p.stripe_checkout_session_id,
  p.stripe_payment_intent_id,
  p.stripe_invoice_id,
  p.stripe_payment_link_id,
  p.refund_status,
  p.refund_amount,
  p.refund_currency,
  p.stripe_refund_id,
  p.stripe_credit_note_id,
  p.refunded_at,
  p.refund_reason,
  p.stripe_receipt_url,
  p.stripe_credit_note_url,

  be.id as booking_event_id,
  be.event_type as booking_event_type,
  be.source as booking_event_source,
  be.payload as booking_event_payload,
  be.status as booking_event_status,
  be.created_at as booking_event_created_at,

  bse.id as side_effect_id,
  bse.entity as side_effect_entity,
  bse.effect_intent as side_effect_intent,
  bse.status as side_effect_status,
  bse.expires_at as side_effect_expires_at,
  bse.max_attempts as side_effect_max_attempts,
  bse.created_at as side_effect_created_at,
  bse.updated_at as side_effect_updated_at,

  bsea.id as side_effect_attempt_id,
  bsea.attempt_num as side_effect_attempt_num,
  bsea.api_log_id as side_effect_attempt_api_log_id,
  bsea.status as side_effect_attempt_status,
  bsea.error_message as side_effect_attempt_error_message,
  bsea.created_at as side_effect_attempt_created_at
  
  -- ,
  -- al.id as api_log_id,
  -- al.created_at as api_log_created_at,
  -- al.completed_at as api_log_completed_at,
  -- al.app_area as api_log_app_area,
  -- al.request_id as api_log_request_id,
  -- al.correlation_id as api_log_correlation_id,
  -- al.booking_id as api_log_booking_id,
  -- al.booking_event_id as api_log_booking_event_id,
  -- al.side_effect_id as api_log_side_effect_id,
  -- al.side_effect_attempt_id as api_log_side_effect_attempt_id,
  -- al.direction as api_log_direction,
  -- al.provider as api_log_provider,
  -- al.method as api_log_method,
  -- al.url as api_log_url,
  -- al.request_headers_redacted,
  -- al.request_body_preview,
  -- al.response_status,
  -- al.response_headers_redacted,
  -- al.response_body_preview,
  -- al.duration_ms,
  -- al.error_code as api_log_error_code,
  -- al.error_message as api_log_error_message,

  -- el.id as exception_log_id,
  -- el.created_at as exception_log_created_at,
  -- el.app_area as exception_log_app_area,
  -- el.request_id as exception_log_request_id,
  -- el.correlation_id as exception_log_correlation_id,
  -- el.booking_id as exception_log_booking_id,
  -- el.booking_event_id as exception_log_booking_event_id,
  -- el.side_effect_id as exception_log_side_effect_id,
  -- el.side_effect_attempt_id as exception_log_side_effect_attempt_id,
  -- el.error_type as exception_log_error_type,
  -- el.error_code as exception_log_error_code,
  -- el.message as exception_log_message,
  -- el.stack_trace,
  -- el.context_json

from public.clients c
left join public.bookings b
  on b.client_id = c.id
left join public.payments p
  on p.booking_id = b.id
left join public.booking_events be
  on be.booking_id = b.id
left join public.booking_side_effects bse
  on bse.booking_event_id = be.id
left join public.booking_side_effect_attempts bsea
  on bsea.booking_side_effect_id = bse.id
-- left join public.api_logs al
--   on al.booking_id = b.id
--  and (al.booking_event_id is null or al.booking_event_id = be.id)
--  and (al.side_effect_id is null or al.side_effect_id = bse.id)
--  and (al.side_effect_attempt_id is null or al.side_effect_attempt_id = bsea.id)
-- left join public.exception_logs el
--   on el.booking_id = b.id
--  and (el.booking_event_id is null or el.booking_event_id = be.id)
--  and (el.side_effect_id is null or el.side_effect_id = bse.id)
--  and (el.side_effect_attempt_id is null or el.side_effect_attempt_id = bsea.id);
