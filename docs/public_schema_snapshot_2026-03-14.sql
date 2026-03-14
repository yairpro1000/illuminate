


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."audience_segment" AS ENUM (
    'all',
    'checked_in',
    'not_checked_in'
);


ALTER TYPE "public"."audience_segment" OWNER TO "postgres";


CREATE TYPE "public"."booking_source" AS ENUM (
    'session',
    'event'
);


ALTER TYPE "public"."booking_source" OWNER TO "postgres";


CREATE TYPE "public"."booking_status" AS ENUM (
    'pending_email',
    'pending_payment',
    'confirmed',
    'cash_ok',
    'cancelled',
    'expired'
);


ALTER TYPE "public"."booking_status" OWNER TO "postgres";


CREATE TYPE "public"."booking_type" AS ENUM (
    'intro',
    'session'
);


ALTER TYPE "public"."booking_type" OWNER TO "postgres";


CREATE TYPE "public"."broadcast_channel" AS ENUM (
    'email',
    'whatsapp'
);


ALTER TYPE "public"."broadcast_channel" OWNER TO "postgres";


CREATE TYPE "public"."broadcast_status" AS ENUM (
    'draft',
    'sending',
    'sent',
    'failed'
);


ALTER TYPE "public"."broadcast_status" OWNER TO "postgres";


CREATE TYPE "public"."contact_message_status" AS ENUM (
    'new',
    'read',
    'replied',
    'archived',
    'spam'
);


ALTER TYPE "public"."contact_message_status" OWNER TO "postgres";


CREATE TYPE "public"."delivery_status" AS ENUM (
    'queued',
    'sent',
    'failed'
);


ALTER TYPE "public"."delivery_status" OWNER TO "postgres";


CREATE TYPE "public"."event_status" AS ENUM (
    'draft',
    'published',
    'cancelled',
    'sold_out'
);


ALTER TYPE "public"."event_status" OWNER TO "postgres";


CREATE TYPE "public"."failure_severity" AS ENUM (
    'debug',
    'info',
    'warning',
    'error',
    'critical'
);


ALTER TYPE "public"."failure_severity" OWNER TO "postgres";


CREATE TYPE "public"."failure_source" AS ENUM (
    'api',
    'stripe_webhook',
    'calendar',
    'email',
    'job',
    'storage',
    'auth'
);


ALTER TYPE "public"."failure_source" OWNER TO "postgres";


CREATE TYPE "public"."failure_status" AS ENUM (
    'open',
    'retrying',
    'resolved',
    'ignored'
);


ALTER TYPE "public"."failure_status" OWNER TO "postgres";


CREATE TYPE "public"."job_status" AS ENUM (
    'running',
    'success',
    'partial_failure',
    'failed'
);


ALTER TYPE "public"."job_status" OWNER TO "postgres";


CREATE TYPE "public"."media_type" AS ENUM (
    'image',
    'video'
);


ALTER TYPE "public"."media_type" OWNER TO "postgres";


CREATE TYPE "public"."payment_kind" AS ENUM (
    'booking',
    'event_registration'
);


ALTER TYPE "public"."payment_kind" OWNER TO "postgres";


CREATE TYPE "public"."payment_status" AS ENUM (
    'pending',
    'succeeded',
    'failed',
    'refunded'
);


ALTER TYPE "public"."payment_status" OWNER TO "postgres";


CREATE TYPE "public"."registration_status" AS ENUM (
    'pending_email',
    'pending_payment',
    'confirmed',
    'cancelled',
    'expired'
);


ALTER TYPE "public"."registration_status" OWNER TO "postgres";


CREATE TYPE "public"."session_type_status" AS ENUM (
    'draft',
    'active',
    'hidden'
);


ALTER TYPE "public"."session_type_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pa_reorder_bucket"("p_list_id" "text", "p_priority" integer, "p_ordered_ids" "uuid"[], "p_expected_revision" bigint, "p_updated_by" "text") RETURNS bigint
    LANGUAGE "plpgsql"
    AS $$
declare
  v_current bigint;
  v_updated int;
  v_next bigint;
begin
  select items_revision into v_current
  from pa_lists
  where list_id = p_list_id
  for update;

  if v_current is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if v_current <> p_expected_revision then
    raise exception 'conflict' using errcode = 'P0001', detail = json_build_object('current', v_current)::text;
  end if;

  update pa_list_items i
  set "order" = u.ord - 1,
      updated_at = now()
  from unnest(p_ordered_ids) with ordinality as u(id, ord)
  where i.id = u.id
    and i.list_id = p_list_id
    and i.priority = p_priority;

  get diagnostics v_updated = row_count;
  if v_updated <> coalesce(array_length(p_ordered_ids, 1), 0) then
    raise exception 'bad_request' using errcode = 'P0001', detail = json_build_object('updated', v_updated)::text;
  end if;

  update pa_lists
  set items_revision = items_revision + 1,
      items_updated_at = now(),
      items_updated_by = p_updated_by
  where list_id = p_list_id
  returning items_revision into v_next;

  return v_next;
end;
$$;


ALTER FUNCTION "public"."pa_reorder_bucket"("p_list_id" "text", "p_priority" integer, "p_ordered_ids" "uuid"[], "p_expected_revision" bigint, "p_updated_by" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pa_reorder_bucket"("p_user_id" "uuid", "p_list_id" "text", "p_priority" integer, "p_ordered_ids" "uuid"[], "p_expected_revision" bigint, "p_updated_by" "text") RETURNS bigint
    LANGUAGE "plpgsql"
    AS $$
declare
  current_rev bigint;
  next_rev bigint;
begin
  if p_list_id is null or btrim(p_list_id) = '' then
    raise exception 'bad_request' using detail = 'Missing list_id.';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'bad_request' using detail = 'Missing/invalid expected_revision.';
  end if;

  -- Lock list row for revision check + atomic update
  select items_revision into current_rev
  from public.pa_lists
  where user_id = p_user_id and list_id = p_list_id
  for update;

  if current_rev is null then
    raise exception 'not_found' using detail = format('List "%s" not found.', p_list_id);
  end if;

  if current_rev <> p_expected_revision then
    raise exception 'conflict'
      using detail = json_build_object('current', current_rev)::text;
  end if;

  -- Apply order updates (0..N-1)
  with ord as (
    select unnest(p_ordered_ids) as id,
           generate_series(0, array_length(p_ordered_ids, 1) - 1) as idx
  )
  update public.pa_list_items it
  set "order" = ord.idx
  from ord
  where
    it.id = ord.id
    and it.user_id = p_user_id
    and it.list_id = p_list_id
    and it.priority = p_priority;

  -- bump revision
  update public.pa_lists
  set
    items_revision = items_revision + 1,
    items_updated_at = now(),
    items_updated_by = p_updated_by
  where user_id = p_user_id and list_id = p_list_id
  returning items_revision into next_rev;

  return next_rev;
end;
$$;


ALTER FUNCTION "public"."pa_reorder_bucket"("p_user_id" "uuid", "p_list_id" "text", "p_priority" integer, "p_ordered_ids" "uuid"[], "p_expected_revision" bigint, "p_updated_by" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pa_touch_list"("p_list_id" "text", "p_updated_by" "text") RETURNS bigint
    LANGUAGE "plpgsql"
    AS $$
declare
  v_next bigint;
begin
  update pa_lists
  set items_revision = items_revision + 1,
      items_updated_at = now(),
      items_updated_by = p_updated_by
  where list_id = p_list_id
  returning items_revision into v_next;

  if v_next is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  return v_next;
end;
$$;


ALTER FUNCTION "public"."pa_touch_list"("p_list_id" "text", "p_updated_by" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pa_touch_list"("p_user_id" "uuid", "p_list_id" "text", "p_updated_by" "text") RETURNS bigint
    LANGUAGE "plpgsql"
    AS $$
declare
  next_rev bigint;
begin
  update public.pa_lists
  set
    items_revision = items_revision + 1,
    items_updated_at = now(),
    items_updated_by = p_updated_by
  where user_id = p_user_id and list_id = p_list_id
  returning items_revision into next_rev;

  if next_rev is null then
    raise exception 'not_found' using detail = format('List "%s" not found.', p_list_id);
  end if;

  return next_rev;
end;
$$;


ALTER FUNCTION "public"."pa_touch_list"("p_user_id" "uuid", "p_list_id" "text", "p_updated_by" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
    new.updated_at = now();
    return new;
end;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."api_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "app_area" "text" NOT NULL,
    "request_id" "text" NOT NULL,
    "correlation_id" "text" NOT NULL,
    "booking_id" "uuid",
    "booking_event_id" "uuid",
    "side_effect_id" "uuid",
    "side_effect_attempt_id" "uuid",
    "direction" "text" NOT NULL,
    "provider" "text",
    "method" "text" NOT NULL,
    "url" "text" NOT NULL,
    "request_headers_redacted" "jsonb",
    "request_body_preview" "jsonb",
    "response_status" integer,
    "response_headers_redacted" "jsonb",
    "response_body_preview" "jsonb",
    "duration_ms" integer,
    "error_code" "text",
    "error_message" "text",
    CONSTRAINT "api_logs_app_area_check" CHECK (("app_area" = ANY (ARRAY['website'::"text", 'admin'::"text", 'pa'::"text"]))),
    CONSTRAINT "api_logs_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"]))),
    CONSTRAINT "api_logs_duration_ms_check" CHECK ((("duration_ms" IS NULL) OR ("duration_ms" >= 0)))
);


ALTER TABLE "public"."api_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."booking_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "source" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "booking_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['BOOKING_FORM_SUBMITTED'::"text", 'BOOKING_RESCHEDULED'::"text", 'BOOKING_CANCELED'::"text", 'BOOKING_EXPIRED'::"text", 'PAYMENT_SETTLED'::"text", 'REFUND_COMPLETED'::"text"]))),
    CONSTRAINT "booking_events_source_check" CHECK (("source" = ANY (ARRAY['PUBLIC_UI'::"text", 'ADMIN_UI'::"text", 'SYSTEM'::"text", 'WEBHOOK'::"text"])))
);


ALTER TABLE "public"."booking_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."booking_side_effect_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_side_effect_id" "uuid" NOT NULL,
    "attempt_num" integer NOT NULL,
    "api_log_id" "text",
    "status" "text" NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "booking_side_effect_attempts_attempt_num_check" CHECK (("attempt_num" >= 1)),
    CONSTRAINT "booking_side_effect_attempts_status_check" CHECK (("status" = ANY (ARRAY['SUCCESS'::"text", 'FAILED'::"text"])))
);


ALTER TABLE "public"."booking_side_effect_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."booking_side_effects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_event_id" "uuid" NOT NULL,
    "entity" "text" NOT NULL,
    "effect_intent" "text" NOT NULL,
    "status" "text" NOT NULL,
    "expires_at" timestamp with time zone,
    "max_attempts" integer DEFAULT 5 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "booking_side_effects_effect_intent_check" CHECK (("effect_intent" = ANY (ARRAY['SEND_BOOKING_CONFIRMATION_REQUEST'::"text", 'SEND_BOOKING_CONFIRMATION'::"text", 'SEND_PAYMENT_LINK'::"text", 'SEND_PAYMENT_REMINDER'::"text", 'SEND_BOOKING_CANCELLATION_CONFIRMATION'::"text", 'SEND_BOOKING_EXPIRATION_NOTIFICATION'::"text", 'SEND_EVENT_REMINDER'::"text", 'CREATE_STRIPE_CHECKOUT'::"text", 'VERIFY_EMAIL_CONFIRMATION'::"text", 'VERIFY_STRIPE_PAYMENT'::"text", 'CREATE_STRIPE_REFUND'::"text", 'RESERVE_CALENDAR_SLOT'::"text", 'UPDATE_CALENDAR_SLOT'::"text", 'CANCEL_CALENDAR_SLOT'::"text"]))),
    CONSTRAINT "booking_side_effects_max_attempts_check" CHECK (("max_attempts" >= 1)),
    CONSTRAINT "booking_side_effects_source_check" CHECK (("entity" = ANY (ARRAY['EMAIL'::"text", 'CALENDAR'::"text", 'PAYMENT'::"text", 'WHATSAPP'::"text", 'SYSTEM'::"text"]))),
    CONSTRAINT "booking_side_effects_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'PROCESSING'::"text",, 'SUCCESS'::"text", 'FAILED'::"text", 'DEAD'::"text"])))
);


ALTER TABLE "public"."booking_side_effects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "event_id" "uuid",
    "session_type_id" "uuid",
    "booking_type" "text" NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "timezone" "text" DEFAULT 'Europe/Zurich'::"text" NOT NULL,
    "google_event_id" "text",
    "address_line" "text" NOT NULL,
    "maps_url" "text" NOT NULL,
    "current_status" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bookings_booking_type_check" CHECK (("booking_type" = ANY (ARRAY['FREE'::"text", 'PAY_NOW'::"text", 'PAY_LATER'::"text"]))),
    CONSTRAINT "bookings_current_status_check" CHECK (("current_status" = ANY (ARRAY['PENDING'::"text", 'CONFIRMED'::"text", 'CANCELED'::"text", 'EXPIRED'::"text", 'COMPLETED'::"text", 'NO_SHOW'::"text"]))),
    CONSTRAINT "bookings_exactly_one_kind_check" CHECK ((((("event_id" IS NOT NULL))::integer + (("session_type_id" IS NOT NULL))::integer) = 1)),
    CONSTRAINT "bookings_time_order_check" CHECK (("ends_at" > "starts_at"))
);


ALTER TABLE "public"."bookings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text",
    "email" "text" NOT NULL,
    "phone" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "timezone" "text" DEFAULT 'Europe/Zurich'::"text" NOT NULL
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid",
    "first_name" "text" NOT NULL,
    "last_name" "text",
    "email" "text" NOT NULL,
    "topic" "text",
    "message" "text" NOT NULL,
    "status" "text" DEFAULT 'NEW'::"text" NOT NULL,
    "source" "text" DEFAULT 'WEBSITE_CONTACT_FORM'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "contact_messages_status_check" CHECK (("status" = ANY (ARRAY['NEW'::"text", 'HANDLED'::"text", 'ARCHIVED'::"text", 'SPAM'::"text"])))
);


ALTER TABLE "public"."contact_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_late_access_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_by_client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone
);


ALTER TABLE "public"."event_late_access_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_reminder_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "phone" "text",
    "event_family" "text" DEFAULT 'illuminate_evenings'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."event_reminder_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text" NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "timezone" "text" DEFAULT 'Europe/Zurich'::"text" NOT NULL,
    "location_name" "text",
    "address_line" "text" NOT NULL,
    "maps_url" "text" NOT NULL,
    "is_paid" boolean DEFAULT false NOT NULL,
    "price_per_person_cents" integer,
    "currency" "text" DEFAULT 'CHF'::"text" NOT NULL,
    "capacity" integer NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "image_key" "text",
    "drive_file_id" "text",
    "image_alt" "text",
    "whatsapp_group_invite_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "events_capacity_check" CHECK (("capacity" > 0)),
    CONSTRAINT "events_paid_requires_price_check" CHECK ((("is_paid" = false) OR (("price_per_person_cents" IS NOT NULL) AND ("price_per_person_cents" > 0)))),
    CONSTRAINT "events_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'PUBLISHED'::"text", 'CANCELED'::"text", 'SOLD_OUT'::"text"]))),
    CONSTRAINT "events_time_order_check" CHECK (("ends_at" > "starts_at"))
);


ALTER TABLE "public"."events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."exception_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "app_area" "text" NOT NULL,
    "request_id" "text" NOT NULL,
    "correlation_id" "text" NOT NULL,
    "booking_id" "uuid",
    "booking_event_id" "uuid",
    "side_effect_id" "uuid",
    "side_effect_attempt_id" "uuid",
    "error_type" "text" NOT NULL,
    "error_code" "text",
    "message" "text" NOT NULL,
    "stack_trace" "text",
    "context_json" "jsonb",
    CONSTRAINT "exception_logs_app_area_check" CHECK (("app_area" = ANY (ARRAY['website'::"text", 'admin'::"text", 'pa'::"text"])))
);


ALTER TABLE "public"."exception_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pa_base_fields" (
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "default_value_json" "jsonb",
    "nullable" boolean DEFAULT false NOT NULL,
    "description" "text",
    "ui_show_in_preview" boolean,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pa_base_fields" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pa_list_aliases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "list_id" "text" NOT NULL,
    "alias" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" NOT NULL
);


ALTER TABLE "public"."pa_list_aliases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pa_list_custom_fields" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "list_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "default_value_json" "jsonb",
    "nullable" boolean DEFAULT false NOT NULL,
    "description" "text",
    "ui_show_in_preview" boolean,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" NOT NULL
);


ALTER TABLE "public"."pa_list_custom_fields" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pa_list_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "list_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "text" "text" NOT NULL,
    "priority" integer DEFAULT 3 NOT NULL,
    "color" "text",
    "status" "text" DEFAULT 'todo'::"text" NOT NULL,
    "order" integer DEFAULT 0 NOT NULL,
    "archived_at" timestamp with time zone,
    "unarchived_at" timestamp with time zone,
    "extra_fields" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "user_id" "uuid" NOT NULL
);


ALTER TABLE "public"."pa_list_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pa_lists" (
    "list_id" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "ui_default_sort" "text",
    "items_revision" bigint DEFAULT 0 NOT NULL,
    "items_updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "items_updated_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" NOT NULL
);


ALTER TABLE "public"."pa_lists" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pa_undo_log" (
    "id" "text" NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "label" "text" NOT NULL,
    "snapshots" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pa_undo_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pa_undo_log_history" (
    "id" "text" NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "label" "text" NOT NULL,
    "snapshots" "jsonb" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "archived_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pa_undo_log_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "booking_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_payment_id" "text",
    "amount_cents" integer NOT NULL,
    "currency" "text" DEFAULT 'CHF'::"text" NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "checkout_url" "text",
    "invoice_url" "text",
    "raw_payload" "jsonb",
    "paid_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payments_amount_cents_check" CHECK (("amount_cents" >= 0)),
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'SUCCEEDED'::"text", 'FAILED'::"text", 'REFUNDED'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."session_types" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "short_description" "text",
    "description" "text" NOT NULL,
    "duration_minutes" integer NOT NULL,
    "price" integer NOT NULL,
    "currency" "text" DEFAULT 'CHF'::"text" NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "image_key" "text",
    "drive_file_id" "text",
    "image_alt" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "session_types_duration_minutes_check" CHECK (("duration_minutes" > 0)),
    CONSTRAINT "session_types_price_check" CHECK (("price" >= 0)),
    CONSTRAINT "session_types_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'ACTIVE'::"text", 'HIDDEN'::"text"])))
);


ALTER TABLE "public"."session_types" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_settings" (
    "domain" "text" NOT NULL,
    "keyname" "text" NOT NULL,
    "readable_name" "text" NOT NULL,
    "value_type" "text" NOT NULL,
    "unit" "text",
    "value" "text" NOT NULL,
    "description" "text" NOT NULL,
    "description_he" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "system_settings_value_type_check" CHECK (("value_type" = ANY (ARRAY['integer'::"text", 'float'::"text", 'boolean'::"text", 'text'::"text", 'json'::"text"])))
);


ALTER TABLE "public"."system_settings" OWNER TO "postgres";


ALTER TABLE ONLY "public"."api_logs"
    ADD CONSTRAINT "api_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_events"
    ADD CONSTRAINT "booking_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_side_effect_attempts"
    ADD CONSTRAINT "booking_side_effect_attempts_booking_side_effect_id_attempt_key" UNIQUE ("booking_side_effect_id", "attempt_num");



ALTER TABLE ONLY "public"."booking_side_effect_attempts"
    ADD CONSTRAINT "booking_side_effect_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_side_effects"
    ADD CONSTRAINT "booking_side_effects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_messages"
    ADD CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_late_access_links"
    ADD CONSTRAINT "event_late_access_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_late_access_links"
    ADD CONSTRAINT "event_late_access_links_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."event_reminder_subscriptions"
    ADD CONSTRAINT "event_reminder_subscriptions_email_event_family_key" UNIQUE ("email", "event_family");



ALTER TABLE ONLY "public"."event_reminder_subscriptions"
    ADD CONSTRAINT "event_reminder_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."exception_logs"
    ADD CONSTRAINT "exception_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pa_base_fields"
    ADD CONSTRAINT "pa_base_fields_pkey" PRIMARY KEY ("name");



ALTER TABLE ONLY "public"."pa_list_aliases"
    ADD CONSTRAINT "pa_list_aliases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pa_list_aliases"
    ADD CONSTRAINT "pa_list_aliases_user_list_alias_key" UNIQUE ("user_id", "list_id", "alias");



ALTER TABLE ONLY "public"."pa_list_custom_fields"
    ADD CONSTRAINT "pa_list_custom_fields_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pa_list_custom_fields"
    ADD CONSTRAINT "pa_list_custom_fields_user_list_name_key" UNIQUE ("user_id", "list_id", "name");



ALTER TABLE ONLY "public"."pa_list_items"
    ADD CONSTRAINT "pa_list_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pa_lists"
    ADD CONSTRAINT "pa_lists_pkey" PRIMARY KEY ("user_id", "list_id");



ALTER TABLE ONLY "public"."pa_undo_log_history"
    ADD CONSTRAINT "pa_undo_log_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pa_undo_log"
    ADD CONSTRAINT "pa_undo_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."session_types"
    ADD CONSTRAINT "session_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."session_types"
    ADD CONSTRAINT "session_types_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "system_settings_pkey" PRIMARY KEY ("keyname");



CREATE INDEX "idx_api_logs_app_area_created_at" ON "public"."api_logs" USING "btree" ("app_area", "created_at" DESC);



CREATE INDEX "idx_api_logs_booking_event_id_created_at" ON "public"."api_logs" USING "btree" ("booking_event_id", "created_at" DESC);



CREATE INDEX "idx_api_logs_booking_id_created_at" ON "public"."api_logs" USING "btree" ("booking_id", "created_at" DESC);



CREATE INDEX "idx_api_logs_correlation_id" ON "public"."api_logs" USING "btree" ("correlation_id");



CREATE INDEX "idx_api_logs_created_at" ON "public"."api_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_api_logs_direction_created_at" ON "public"."api_logs" USING "btree" ("direction", "created_at" DESC);



CREATE INDEX "idx_api_logs_error_code_created_at" ON "public"."api_logs" USING "btree" ("error_code", "created_at" DESC) WHERE ("error_code" IS NOT NULL);



CREATE INDEX "idx_api_logs_provider_created_at" ON "public"."api_logs" USING "btree" ("provider", "created_at" DESC) WHERE ("provider" IS NOT NULL);



CREATE INDEX "idx_api_logs_request_id" ON "public"."api_logs" USING "btree" ("request_id");



CREATE INDEX "idx_api_logs_response_status_created_at" ON "public"."api_logs" USING "btree" ("response_status", "created_at" DESC) WHERE ("response_status" IS NOT NULL);



CREATE INDEX "idx_api_logs_side_effect_attempt_id_created_at" ON "public"."api_logs" USING "btree" ("side_effect_attempt_id", "created_at" DESC);



CREATE INDEX "idx_api_logs_side_effect_id_created_at" ON "public"."api_logs" USING "btree" ("side_effect_id", "created_at" DESC);



CREATE INDEX "idx_booking_events_booking_created" ON "public"."booking_events" USING "btree" ("booking_id", "created_at" DESC);



CREATE INDEX "idx_booking_events_confirm_token_hash" ON "public"."booking_events" USING "btree" ((("payload" ->> 'confirm_token_hash'::"text")), "created_at" DESC) WHERE ("payload" ? 'confirm_token_hash'::"text");



CREATE INDEX "idx_booking_events_type_created" ON "public"."booking_events" USING "btree" ("event_type", "created_at" DESC);



CREATE INDEX "idx_booking_side_effect_attempts_effect_created" ON "public"."booking_side_effect_attempts" USING "btree" ("booking_side_effect_id", "created_at" DESC);



CREATE INDEX "idx_booking_side_effects_event_created" ON "public"."booking_side_effects" USING "btree" ("booking_event_id", "created_at");



CREATE INDEX "idx_booking_side_effects_intent_status" ON "public"."booking_side_effects" USING "btree" ("effect_intent", "status", "created_at");



CREATE INDEX "idx_booking_side_effects_pending_due" ON "public"."booking_side_effects" USING "btree" ("expires_at", "created_at") WHERE ("status" = ANY (ARRAY['PENDING'::"text", 'FAILED'::"text"]));



CREATE INDEX "idx_booking_side_effects_status_created" ON "public"."booking_side_effects" USING "btree" ("status", "created_at");



CREATE INDEX "idx_bookings_client_created" ON "public"."bookings" USING "btree" ("client_id", "created_at" DESC);



CREATE INDEX "idx_bookings_event_status_start" ON "public"."bookings" USING "btree" ("event_id", "current_status", "starts_at") WHERE ("event_id" IS NOT NULL);



CREATE INDEX "idx_bookings_google_event_id" ON "public"."bookings" USING "btree" ("google_event_id") WHERE ("google_event_id" IS NOT NULL);



CREATE INDEX "idx_bookings_session_status_start" ON "public"."bookings" USING "btree" ("session_type_id", "current_status", "starts_at") WHERE ("session_type_id" IS NOT NULL);



CREATE INDEX "idx_bookings_status_start" ON "public"."bookings" USING "btree" ("current_status", "starts_at");



CREATE INDEX "idx_bookings_type_status_start" ON "public"."bookings" USING "btree" ("booking_type", "current_status", "starts_at");



CREATE INDEX "idx_clients_created_at" ON "public"."clients" USING "btree" ("created_at" DESC);



CREATE UNIQUE INDEX "idx_clients_email_unique" ON "public"."clients" USING "btree" ("lower"("email"));



CREATE INDEX "idx_contact_messages_client_id" ON "public"."contact_messages" USING "btree" ("client_id");



CREATE INDEX "idx_contact_messages_email" ON "public"."contact_messages" USING "btree" ("email");



CREATE INDEX "idx_contact_messages_status_created" ON "public"."contact_messages" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_event_late_access_event" ON "public"."event_late_access_links" USING "btree" ("event_id", "expires_at" DESC);



CREATE INDEX "idx_events_status_starts" ON "public"."events" USING "btree" ("status", "starts_at");



CREATE INDEX "idx_exception_logs_app_area_created_at" ON "public"."exception_logs" USING "btree" ("app_area", "created_at" DESC);



CREATE INDEX "idx_exception_logs_booking_event_id_created_at" ON "public"."exception_logs" USING "btree" ("booking_event_id", "created_at" DESC);



CREATE INDEX "idx_exception_logs_booking_id_created_at" ON "public"."exception_logs" USING "btree" ("booking_id", "created_at" DESC);



CREATE INDEX "idx_exception_logs_correlation_id" ON "public"."exception_logs" USING "btree" ("correlation_id");



CREATE INDEX "idx_exception_logs_created_at" ON "public"."exception_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_exception_logs_error_code_created_at" ON "public"."exception_logs" USING "btree" ("error_code", "created_at" DESC) WHERE ("error_code" IS NOT NULL);



CREATE INDEX "idx_exception_logs_error_type_created_at" ON "public"."exception_logs" USING "btree" ("error_type", "created_at" DESC);



CREATE INDEX "idx_exception_logs_request_id" ON "public"."exception_logs" USING "btree" ("request_id");



CREATE INDEX "idx_exception_logs_side_effect_attempt_id_created_at" ON "public"."exception_logs" USING "btree" ("side_effect_attempt_id", "created_at" DESC);



CREATE INDEX "idx_exception_logs_side_effect_id_created_at" ON "public"."exception_logs" USING "btree" ("side_effect_id", "created_at" DESC);



CREATE INDEX "idx_pa_list_items_list_archived_at" ON "public"."pa_list_items" USING "btree" ("list_id", "archived_at");



CREATE INDEX "idx_pa_list_items_list_created_at" ON "public"."pa_list_items" USING "btree" ("list_id", "created_at" DESC);



CREATE INDEX "idx_pa_list_items_list_priority_order" ON "public"."pa_list_items" USING "btree" ("list_id", "priority", "order");



CREATE INDEX "idx_pa_undo_log_history_user" ON "public"."pa_undo_log_history" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_pa_undo_log_user" ON "public"."pa_undo_log" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_payments_booking" ON "public"."payments" USING "btree" ("booking_id", "created_at" DESC);



CREATE INDEX "idx_payments_provider_payment" ON "public"."payments" USING "btree" ("provider", "provider_payment_id");



CREATE INDEX "idx_payments_status" ON "public"."payments" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_session_types_status_order" ON "public"."session_types" USING "btree" ("status", "sort_order", "created_at");



CREATE UNIQUE INDEX "idx_system_settings_domain_keyname" ON "public"."system_settings" USING "btree" ("domain", "keyname");



CREATE INDEX "pa_list_aliases_user_list_id_idx" ON "public"."pa_list_aliases" USING "btree" ("user_id", "list_id");



CREATE INDEX "pa_list_custom_fields_user_list_id_idx" ON "public"."pa_list_custom_fields" USING "btree" ("user_id", "list_id");



CREATE INDEX "pa_list_items_user_list_archived_at_idx" ON "public"."pa_list_items" USING "btree" ("user_id", "list_id", "archived_at");



CREATE INDEX "pa_list_items_user_list_created_at_desc_idx" ON "public"."pa_list_items" USING "btree" ("user_id", "list_id", "created_at" DESC);



CREATE INDEX "pa_list_items_user_list_priority_order_idx" ON "public"."pa_list_items" USING "btree" ("user_id", "list_id", "priority", "order");



CREATE INDEX "pa_lists_user_id_idx" ON "public"."pa_lists" USING "btree" ("user_id");



CREATE OR REPLACE TRIGGER "trg_clients_updated_at" BEFORE UPDATE ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."api_logs"
    ADD CONSTRAINT "api_logs_booking_event_id_fkey" FOREIGN KEY ("booking_event_id") REFERENCES "public"."booking_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_logs"
    ADD CONSTRAINT "api_logs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_logs"
    ADD CONSTRAINT "api_logs_side_effect_attempt_id_fkey" FOREIGN KEY ("side_effect_attempt_id") REFERENCES "public"."booking_side_effect_attempts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_logs"
    ADD CONSTRAINT "api_logs_side_effect_id_fkey" FOREIGN KEY ("side_effect_id") REFERENCES "public"."booking_side_effects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."booking_events"
    ADD CONSTRAINT "booking_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."booking_side_effect_attempts"
    ADD CONSTRAINT "booking_side_effect_attempts_booking_side_effect_id_fkey" FOREIGN KEY ("booking_side_effect_id") REFERENCES "public"."booking_side_effects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."booking_side_effects"
    ADD CONSTRAINT "booking_side_effects_booking_event_id_fkey" FOREIGN KEY ("booking_event_id") REFERENCES "public"."booking_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_session_type_id_fkey" FOREIGN KEY ("session_type_id") REFERENCES "public"."session_types"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."contact_messages"
    ADD CONSTRAINT "contact_messages_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."event_late_access_links"
    ADD CONSTRAINT "event_late_access_links_created_by_client_id_fkey" FOREIGN KEY ("created_by_client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."event_late_access_links"
    ADD CONSTRAINT "event_late_access_links_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."exception_logs"
    ADD CONSTRAINT "exception_logs_booking_event_id_fkey" FOREIGN KEY ("booking_event_id") REFERENCES "public"."booking_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."exception_logs"
    ADD CONSTRAINT "exception_logs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."exception_logs"
    ADD CONSTRAINT "exception_logs_side_effect_attempt_id_fkey" FOREIGN KEY ("side_effect_attempt_id") REFERENCES "public"."booking_side_effect_attempts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."exception_logs"
    ADD CONSTRAINT "exception_logs_side_effect_id_fkey" FOREIGN KEY ("side_effect_id") REFERENCES "public"."booking_side_effects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pa_list_aliases"
    ADD CONSTRAINT "pa_list_aliases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."pa_list_aliases"
    ADD CONSTRAINT "pa_list_aliases_user_list_fkey" FOREIGN KEY ("user_id", "list_id") REFERENCES "public"."pa_lists"("user_id", "list_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pa_list_custom_fields"
    ADD CONSTRAINT "pa_list_custom_fields_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."pa_list_custom_fields"
    ADD CONSTRAINT "pa_list_custom_fields_user_list_fkey" FOREIGN KEY ("user_id", "list_id") REFERENCES "public"."pa_lists"("user_id", "list_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pa_list_items"
    ADD CONSTRAINT "pa_list_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."pa_list_items"
    ADD CONSTRAINT "pa_list_items_user_list_fkey" FOREIGN KEY ("user_id", "list_id") REFERENCES "public"."pa_lists"("user_id", "list_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pa_lists"
    ADD CONSTRAINT "pa_lists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."pa_undo_log_history"
    ADD CONSTRAINT "pa_undo_log_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."pa_undo_log"
    ADD CONSTRAINT "pa_undo_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE;



ALTER TABLE "public"."api_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."booking_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."booking_side_effect_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."booking_side_effects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_late_access_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."event_reminder_subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."exception_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pa_base_fields" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pa_list_aliases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pa_list_custom_fields" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pa_list_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pa_lists" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pa_undo_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pa_undo_log_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."session_types" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."system_settings" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."pa_reorder_bucket"("p_list_id" "text", "p_priority" integer, "p_ordered_ids" "uuid"[], "p_expected_revision" bigint, "p_updated_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pa_reorder_bucket"("p_list_id" "text", "p_priority" integer, "p_ordered_ids" "uuid"[], "p_expected_revision" bigint, "p_updated_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pa_reorder_bucket"("p_list_id" "text", "p_priority" integer, "p_ordered_ids" "uuid"[], "p_expected_revision" bigint, "p_updated_by" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."pa_reorder_bucket"("p_user_id" "uuid", "p_list_id" "text", "p_priority" integer, "p_ordered_ids" "uuid"[], "p_expected_revision" bigint, "p_updated_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pa_reorder_bucket"("p_user_id" "uuid", "p_list_id" "text", "p_priority" integer, "p_ordered_ids" "uuid"[], "p_expected_revision" bigint, "p_updated_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pa_reorder_bucket"("p_user_id" "uuid", "p_list_id" "text", "p_priority" integer, "p_ordered_ids" "uuid"[], "p_expected_revision" bigint, "p_updated_by" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."pa_touch_list"("p_list_id" "text", "p_updated_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pa_touch_list"("p_list_id" "text", "p_updated_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pa_touch_list"("p_list_id" "text", "p_updated_by" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."pa_touch_list"("p_user_id" "uuid", "p_list_id" "text", "p_updated_by" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pa_touch_list"("p_user_id" "uuid", "p_list_id" "text", "p_updated_by" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pa_touch_list"("p_user_id" "uuid", "p_list_id" "text", "p_updated_by" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON TABLE "public"."api_logs" TO "anon";
GRANT ALL ON TABLE "public"."api_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."api_logs" TO "service_role";



GRANT ALL ON TABLE "public"."booking_events" TO "anon";
GRANT ALL ON TABLE "public"."booking_events" TO "authenticated";
GRANT ALL ON TABLE "public"."booking_events" TO "service_role";



GRANT ALL ON TABLE "public"."booking_side_effect_attempts" TO "anon";
GRANT ALL ON TABLE "public"."booking_side_effect_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."booking_side_effect_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."booking_side_effects" TO "anon";
GRANT ALL ON TABLE "public"."booking_side_effects" TO "authenticated";
GRANT ALL ON TABLE "public"."booking_side_effects" TO "service_role";



GRANT ALL ON TABLE "public"."bookings" TO "anon";
GRANT ALL ON TABLE "public"."bookings" TO "authenticated";
GRANT ALL ON TABLE "public"."bookings" TO "service_role";



GRANT ALL ON TABLE "public"."clients" TO "anon";
GRANT ALL ON TABLE "public"."clients" TO "authenticated";
GRANT ALL ON TABLE "public"."clients" TO "service_role";



GRANT ALL ON TABLE "public"."contact_messages" TO "anon";
GRANT ALL ON TABLE "public"."contact_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_messages" TO "service_role";



GRANT ALL ON TABLE "public"."event_late_access_links" TO "anon";
GRANT ALL ON TABLE "public"."event_late_access_links" TO "authenticated";
GRANT ALL ON TABLE "public"."event_late_access_links" TO "service_role";



GRANT ALL ON TABLE "public"."event_reminder_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."event_reminder_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."event_reminder_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."events" TO "anon";
GRANT ALL ON TABLE "public"."events" TO "authenticated";
GRANT ALL ON TABLE "public"."events" TO "service_role";



GRANT ALL ON TABLE "public"."exception_logs" TO "anon";
GRANT ALL ON TABLE "public"."exception_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."exception_logs" TO "service_role";



GRANT ALL ON TABLE "public"."pa_base_fields" TO "anon";
GRANT ALL ON TABLE "public"."pa_base_fields" TO "authenticated";
GRANT ALL ON TABLE "public"."pa_base_fields" TO "service_role";



GRANT ALL ON TABLE "public"."pa_list_aliases" TO "anon";
GRANT ALL ON TABLE "public"."pa_list_aliases" TO "authenticated";
GRANT ALL ON TABLE "public"."pa_list_aliases" TO "service_role";



GRANT ALL ON TABLE "public"."pa_list_custom_fields" TO "anon";
GRANT ALL ON TABLE "public"."pa_list_custom_fields" TO "authenticated";
GRANT ALL ON TABLE "public"."pa_list_custom_fields" TO "service_role";



GRANT ALL ON TABLE "public"."pa_list_items" TO "anon";
GRANT ALL ON TABLE "public"."pa_list_items" TO "authenticated";
GRANT ALL ON TABLE "public"."pa_list_items" TO "service_role";



GRANT ALL ON TABLE "public"."pa_lists" TO "anon";
GRANT ALL ON TABLE "public"."pa_lists" TO "authenticated";
GRANT ALL ON TABLE "public"."pa_lists" TO "service_role";



GRANT ALL ON TABLE "public"."pa_undo_log" TO "anon";
GRANT ALL ON TABLE "public"."pa_undo_log" TO "authenticated";
GRANT ALL ON TABLE "public"."pa_undo_log" TO "service_role";



GRANT ALL ON TABLE "public"."pa_undo_log_history" TO "anon";
GRANT ALL ON TABLE "public"."pa_undo_log_history" TO "authenticated";
GRANT ALL ON TABLE "public"."pa_undo_log_history" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."session_types" TO "anon";
GRANT ALL ON TABLE "public"."session_types" TO "authenticated";
GRANT ALL ON TABLE "public"."session_types" TO "service_role";



GRANT ALL ON TABLE "public"."system_settings" TO "anon";
GRANT ALL ON TABLE "public"."system_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."system_settings" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







