// ── Status enums ──────────────────────────────────────────────────────────────

export type BookingStatus =
  | 'pending_email'
  | 'pending_payment'
  | 'confirmed'
  | 'cash_ok'
  | 'cancelled'
  | 'expired';

export type EventStatus = 'draft' | 'published' | 'cancelled' | 'sold_out';

export type RegistrationStatus =
  | 'pending_email'
  | 'pending_payment'
  | 'confirmed'
  | 'cancelled'
  | 'expired';

export type PaymentKind = 'booking' | 'event_registration';
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';

export type FailureSource =
  | 'api'
  | 'stripe_webhook'
  | 'calendar'
  | 'email'
  | 'job'
  | 'storage'
  | 'auth';

export type FailureSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';
export type FailureStatus = 'open' | 'retrying' | 'resolved' | 'ignored';
export type JobStatus = 'running' | 'success' | 'partial_failure' | 'failed';

// ── Domain models (mirror DB schema exactly) ─────────────────────────────────

export interface Booking {
  id: string;
  client_name: string;
  client_email: string;
  client_phone: string | null;
  starts_at: string; // ISO 8601 with tz offset
  ends_at: string;
  timezone: string;
  address_line: string;
  maps_url: string;
  status: BookingStatus;
  confirm_token_hash: string | null;
  confirm_expires_at: string | null;
  manage_token_hash: string;
  checkout_hold_expires_at: string | null;
  payment_due_at: string | null;
  payment_due_reminder_scheduled_at: string | null;
  payment_due_reminder_sent_at: string | null;
  followup_scheduled_at: string | null;
  followup_sent_at: string | null;
  reminder_email_opt_in: boolean;
  reminder_whatsapp_opt_in: boolean;
  reminder_24h_scheduled_at: string | null;
  reminder_24h_sent_at: string | null;
  google_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  slug: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  location_name: string | null;
  address_line: string;
  maps_url: string;
  is_paid: boolean;
  price_per_person_cents: number | null;
  currency: string;
  capacity: number | null;
  status: EventStatus;
  created_at: string;
  updated_at: string;
}

export interface EventRegistration {
  id: string;
  event_id: string;
  primary_name: string;
  primary_email: string;
  primary_phone: string | null;
  attendee_count: number;
  status: RegistrationStatus;
  confirm_token_hash: string | null;
  confirm_expires_at: string | null;
  manage_token_hash: string;
  checkout_hold_expires_at: string | null;
  followup_scheduled_at: string | null;
  followup_sent_at: string | null;
  reminder_email_opt_in: boolean;
  reminder_whatsapp_opt_in: boolean;
  reminder_24h_scheduled_at: string | null;
  reminder_24h_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventAttendee {
  id: string;
  registration_id: string;
  full_name: string;
  sort_order: number;
}

export interface Payment {
  id: string;
  kind: PaymentKind;
  booking_id: string | null;
  event_registration_id: string | null;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  invoice_url: string | null;
  amount_cents: number;
  currency: string;
  status: PaymentStatus;
  created_at: string;
  updated_at: string;
}

export interface FailureLog {
  id: string;
  source: FailureSource;
  operation: string;
  severity: FailureSeverity;
  status: FailureStatus;
  request_id: string | null;
  idempotency_key: string | null;
  job_run_id: string | null;
  booking_id: string | null;
  event_id: string | null;
  event_registration_id: string | null;
  payment_id: string | null;
  stripe_event_id: string | null;
  stripe_checkout_session_id: string | null;
  google_event_id: string | null;
  email_provider_message_id: string | null;
  error_code: string | null;
  error_message: string;
  error_stack: string | null;
  http_status: number | null;
  retryable: boolean;
  context: Record<string, unknown>;
  attempts: number;
  next_retry_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRun {
  id: string;
  job_name: string;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  items_found: number;
  items_processed: number;
  items_succeeded: number;
  items_failed: number;
  trigger_source: string;
  request_id: string | null;
  error_summary: string | null;
  created_at: string;
}

// ── Repository input types ────────────────────────────────────────────────────
// Omit DB-generated fields; repository adds id + timestamps.

export type NewBooking = Omit<Booking, 'id' | 'created_at' | 'updated_at'>;
export type NewEventRegistration = Omit<EventRegistration, 'id' | 'created_at' | 'updated_at'>;
export type NewPayment = Omit<Payment, 'id' | 'created_at' | 'updated_at'>;

// Only fields that business logic is allowed to mutate after creation.
export type BookingUpdate = Partial<
  Pick<
    Booking,
    | 'status'
    | 'confirm_token_hash'
    | 'confirm_expires_at'
    | 'manage_token_hash'
    | 'checkout_hold_expires_at'
    | 'payment_due_at'
    | 'payment_due_reminder_scheduled_at'
    | 'payment_due_reminder_sent_at'
    | 'followup_scheduled_at'
    | 'followup_sent_at'
    | 'reminder_24h_scheduled_at'
    | 'reminder_24h_sent_at'
    | 'google_event_id'
  >
>;

export type RegistrationUpdate = Partial<
  Pick<
    EventRegistration,
    | 'status'
    | 'confirm_token_hash'
    | 'confirm_expires_at'
    | 'manage_token_hash'
    | 'checkout_hold_expires_at'
    | 'followup_scheduled_at'
    | 'followup_sent_at'
    | 'reminder_24h_scheduled_at'
    | 'reminder_24h_sent_at'
  >
>;

export type PaymentUpdate = Partial<
  Pick<
    Payment,
    | 'status'
    | 'stripe_payment_intent_id'
    | 'stripe_invoice_id'
    | 'invoice_url'
  >
>;

export type JobRunUpdate = Partial<
  Pick<
    JobRun,
    | 'status'
    | 'finished_at'
    | 'items_found'
    | 'items_processed'
    | 'items_succeeded'
    | 'items_failed'
    | 'error_summary'
  >
>;

// ── Shared slot type ──────────────────────────────────────────────────────────

export interface TimeSlot {
  start: string; // ISO 8601
  end: string;
}

// ── Logging input ─────────────────────────────────────────────────────────────

export interface NewFailureLog {
  source: FailureSource;
  operation: string;
  severity?: FailureSeverity;
  request_id?: string | null;
  job_run_id?: string | null;
  booking_id?: string | null;
  event_id?: string | null;
  event_registration_id?: string | null;
  payment_id?: string | null;
  stripe_event_id?: string | null;
  stripe_checkout_session_id?: string | null;
  error_code?: string | null;
  error_message: string;
  error_stack?: string | null;
  http_status?: number | null;
  retryable?: boolean;
  context?: Record<string, unknown>;
}

export interface NewJobRun {
  job_name: string;
  trigger_source?: string;
  request_id?: string | null;
}
