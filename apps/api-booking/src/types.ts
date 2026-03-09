// ── Enums ────────────────────────────────────────────────────────────────────

export type BookingSource = 'session' | 'event';
export type BookingStatus =
  | 'pending_email'
  | 'pending_payment'
  | 'confirmed'
  | 'cash_ok'
  | 'cancelled'
  | 'expired';

export type SessionType = 'intro' | 'session';
export type EventStatus = 'draft' | 'published' | 'cancelled' | 'sold_out';
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';
export type PaymentProvider = 'stripe' | 'mock';

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
export type CalendarSyncOperation = 'create' | 'update' | 'delete';

// ── Core models ──────────────────────────────────────────────────────────────

export interface Client {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

export interface Booking {
  id: string;
  client_id: string;
  source: BookingSource;
  status: BookingStatus;
  event_id: string | null;
  session_type: SessionType | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  address_line: string;
  maps_url: string;
  attended: boolean;
  notes: string | null;
  confirm_token_hash: string | null;
  confirm_expires_at: string | null;
  manage_token_hash: string;
  checkout_session_id: string | null;
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

  // Convenience fields from joins.
  client_first_name?: string;
  client_last_name?: string | null;
  client_email?: string;
  client_phone?: string | null;
  event_title?: string | null;
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
  capacity: number;
  status: EventStatus;
  created_at: string;
  updated_at: string;
}

export interface EventLateAccessLink {
  id: string;
  event_id: string;
  token_hash: string;
  expires_at: string;
  created_by_client_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface EventReminderSubscription {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  event_family: string;
  created_at: string;
}

export interface ContactMessage {
  id: string;
  client_id: string | null;
  first_name: string;
  last_name: string | null;
  email: string;
  topic: string | null;
  message: string;
  status: 'new' | 'read' | 'replied' | 'archived' | 'spam';
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  booking_id: string;
  provider: PaymentProvider;
  provider_payment_id: string | null;
  amount_cents: number;
  currency: string;
  status: PaymentStatus;
  checkout_url: string | null;
  invoice_url: string | null;
  raw_payload: Record<string, unknown> | null;
  paid_at: string | null;
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
  booking_id: string | null;
  payment_id: string | null;
  client_id: string | null;
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

export interface CalendarSyncFailure {
  id: string;
  booking_id: string;
  operation: CalendarSyncOperation;
  attempts: number;
  next_retry_at: string | null;
  last_error: string;
  resolved_at: string | null;
  status: FailureStatus;
}

// ── PA organizer view models ─────────────────────────────────────────────────

export interface OrganizerBookingRow {
  booking_id: string;
  source: BookingSource;
  status: BookingStatus;
  event_id: string | null;
  event_title: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  attended: boolean;
  notes: string | null;
  client_id: string;
  client_first_name: string;
  client_last_name: string | null;
  client_email: string;
  client_phone: string | null;
}

// ── Repository input types ───────────────────────────────────────────────────

export type NewClient = Omit<Client, 'id' | 'created_at' | 'updated_at'>;
export type NewBooking = Omit<Booking,
  | 'id'
  | 'created_at'
  | 'updated_at'
  | 'client_first_name'
  | 'client_last_name'
  | 'client_email'
  | 'client_phone'
  | 'event_title'
>;
export type NewPayment = Omit<Payment, 'id' | 'created_at' | 'updated_at'>;
export type NewContactMessage = Omit<ContactMessage, 'id' | 'created_at' | 'updated_at'>;
export type NewEventReminderSubscription = Omit<EventReminderSubscription, 'id' | 'created_at'>;
export type NewEventLateAccessLink = Omit<EventLateAccessLink, 'id' | 'created_at' | 'revoked_at'>;

export type BookingUpdate = Partial<
  Pick<
    Booking,
    | 'status'
    | 'session_type'
    | 'starts_at'
    | 'ends_at'
    | 'timezone'
    | 'attended'
    | 'notes'
    | 'confirm_token_hash'
    | 'confirm_expires_at'
    | 'manage_token_hash'
    | 'checkout_session_id'
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

export type ClientUpdate = Partial<
  Pick<Client, 'first_name' | 'last_name' | 'email' | 'phone'>
>;

export type PaymentUpdate = Partial<
  Pick<Payment, 'status' | 'provider_payment_id' | 'invoice_url' | 'paid_at' | 'raw_payload'>
>;

// ── Shared helpers ────────────────────────────────────────────────────────────

export interface TimeSlot {
  start: string;
  end: string;
}

export interface EventCutoffState {
  now_iso: string;
  public_registration_open: boolean;
  late_access_open: boolean;
  reminder_signup_recommended: boolean;
}

export interface NewFailureLog {
  source: FailureSource;
  operation: string;
  severity?: FailureSeverity;
  request_id?: string | null;
  booking_id?: string | null;
  payment_id?: string | null;
  client_id?: string | null;
  idempotency_key?: string | null;
  stripe_event_id?: string | null;
  stripe_checkout_session_id?: string | null;
  google_event_id?: string | null;
  email_provider_message_id?: string | null;
  error_code?: string | null;
  error_message: string;
  error_stack?: string | null;
  http_status?: number | null;
  retryable?: boolean;
  context?: Record<string, unknown>;
}
