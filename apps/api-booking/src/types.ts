// ── Booking domain enums ────────────────────────────────────────────────────

export type BookingCurrentStatus =
  | 'PENDING_CONFIRMATION'
  | 'SLOT_CONFIRMED'
  | 'PAID'
  | 'EXPIRED'
  | 'CANCELED'
  | 'COMPLETED'
  | 'NO_SHOW'
  | 'REFUNDED';

export type BookingEventType =
  | 'BOOKING_FORM_SUBMITTED_FREE'
  | 'BOOKING_FORM_SUBMITTED_PAY_NOW'
  | 'BOOKING_FORM_SUBMITTED_PAY_LATER'
  | 'EMAIL_CONFIRMED'
  | 'BOOKING_RESCHEDULED'
  | 'SLOT_RESERVATION_REMINDER_SENT'
  | 'PAYMENT_REMINDER_SENT'
  | 'DATE_REMINDER_SENT'
  | 'BOOKING_EXPIRED'
  | 'BOOKING_CANCELED'
  | 'CASH_AUTHORIZED'
  | 'PAYMENT_SETTLED'
  | 'SLOT_CONFIRMED'
  | 'BOOKING_CLOSED'
  | 'REFUND_REQUESTED'
  | 'REFUND_CREATED'
  | 'REFUND_VERIFIED';

export type BookingEventSource = 'public_ui' | 'admin_ui' | 'job' | 'webhook' | 'system';

export type BookingSideEffectEntity = 'email' | 'calendar' | 'payment' | 'system';

export type BookingSideEffectStatus = 'pending' | 'processing' | 'success' | 'failed' | 'dead';

export type BookingSideEffectAttemptStatus = 'success' | 'fail';

export type BookingEffectIntent =
  | 'send_email_confirmation'
  | 'send_slot_reservation_reminder'
  | 'send_payment_reminder'
  | 'send_date_reminder'
  | 'send_booking_failed_notification'
  | 'send_booking_cancellation_confirmation'
  | 'send_booking_confirmation'
  | 'reserve_slot'
  | 'update_reserved_slot'
  | 'cancel_reserved_slot'
  | 'create_stripe_checkout'
  | 'verify_stripe_payment'
  | 'create_stripe_refund'
  | 'verify_stripe_refund'
  | 'send_payment_link'
  | 'expire_booking'
  | 'close_booking';

// ── Other domain enums ──────────────────────────────────────────────────────

export type EventStatus = 'draft' | 'published' | 'cancelled' | 'sold_out';
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';
export type PaymentProvider = 'stripe' | 'mock';

// ── Core models ─────────────────────────────────────────────────────────────

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
  event_id: string | null;
  session_type_id: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  google_event_id: string | null;
  address_line: string;
  maps_url: string;
  current_status: BookingCurrentStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;

  // Convenience fields from joins
  client_first_name?: string;
  client_last_name?: string | null;
  client_email?: string;
  client_phone?: string | null;
  event_title?: string | null;
  session_type_title?: string | null;
}

export interface BookingEventRecord {
  id: string;
  booking_id: string;
  event_type: BookingEventType;
  source: BookingEventSource;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface BookingSideEffect {
  id: string;
  booking_event_id: string;
  entity: BookingSideEffectEntity;
  effect_intent: BookingEffectIntent;
  status: BookingSideEffectStatus;
  expires_at: string | null;
  max_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface BookingSideEffectAttempt {
  id: string;
  booking_side_effect_id: string;
  attempt_num: number;
  api_log_id: string | null;
  status: BookingSideEffectAttemptStatus;
  error_message: string | null;
  created_at: string;
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
  image_key?: string | null;
  drive_file_id?: string | null;
  image_alt?: string | null;
  whatsapp_group_invite_url?: string | null;
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

// ── Session types (offers) ─────────────────────────────────────────────────

export type SessionTypeStatus = 'draft' | 'active' | 'hidden';

export interface SessionTypeRecord {
  id: string;
  title: string;
  slug: string;
  short_description: string | null;
  description: string;
  duration_minutes: number;
  price: number; // cents
  currency: string;
  status: SessionTypeStatus;
  sort_order: number;
  image_key: string | null;
  drive_file_id: string | null;
  image_alt: string | null;
  created_at: string;
  updated_at: string;
}

export type EventUpdate = Partial<Pick<Event,
  | 'slug'
  | 'title'
  | 'description'
  | 'starts_at'
  | 'ends_at'
  | 'timezone'
  | 'location_name'
  | 'address_line'
  | 'maps_url'
  | 'is_paid'
  | 'price_per_person_cents'
  | 'currency'
  | 'capacity'
  | 'status'
  | 'image_key'
  | 'drive_file_id'
  | 'image_alt'
  | 'whatsapp_group_invite_url'
>>;

export type NewSessionType = Omit<SessionTypeRecord, 'id' | 'created_at' | 'updated_at'>;
export type SessionTypeUpdate = Partial<
  Pick<
    SessionTypeRecord,
    | 'title'
    | 'slug'
    | 'short_description'
    | 'description'
    | 'duration_minutes'
    | 'price'
    | 'currency'
    | 'status'
    | 'sort_order'
    | 'image_key'
    | 'drive_file_id'
    | 'image_alt'
  >
>;

export interface ContactMessage {
  id: string;
  client_id: string;
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

// ── Admin/read models ───────────────────────────────────────────────────────

export interface OrganizerBookingRow {
  booking_id: string;
  current_status: BookingCurrentStatus;
  event_id: string | null;
  event_title: string | null;
  session_type_id: string | null;
  session_type_title: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  google_event_id: string | null;
  address_line: string;
  maps_url: string;
  payment_amount_cents: number | null;
  payment_currency: string | null;
  payment_status: PaymentStatus | null;
  latest_event_type: BookingEventType | null;
  latest_event_at: string | null;
  latest_side_effect_attempt_status: BookingSideEffectAttemptStatus | null;
  latest_side_effect_attempt_at: string | null;
  payment_latest_event_type: BookingEventType | null;
  payment_latest_event_at: string | null;
  payment_latest_side_effect_attempt_status: BookingSideEffectAttemptStatus | null;
  payment_latest_side_effect_attempt_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  client_id: string;
  client_first_name: string;
  client_last_name: string | null;
  client_email: string;
  client_phone: string | null;
}

// ── Repository input types ──────────────────────────────────────────────────

export type NewClient = Omit<Client, 'id' | 'created_at' | 'updated_at'>;

export type NewBooking = Omit<
  Booking,
  | 'id'
  | 'created_at'
  | 'updated_at'
  | 'client_first_name'
  | 'client_last_name'
  | 'client_email'
  | 'client_phone'
  | 'event_title'
  | 'session_type_title'
>;

export type NewBookingEvent = Omit<BookingEventRecord, 'id' | 'created_at'>;
export type NewBookingSideEffect = Omit<BookingSideEffect, 'id' | 'created_at' | 'updated_at'>;
export type NewBookingSideEffectAttempt = Omit<BookingSideEffectAttempt, 'id' | 'created_at'>;

export type NewPayment = Omit<Payment, 'id' | 'created_at' | 'updated_at'>;
export type NewContactMessage = Omit<ContactMessage, 'id' | 'created_at' | 'updated_at'>;
export type NewEventReminderSubscription = Omit<EventReminderSubscription, 'id' | 'created_at'>;
export type NewEventLateAccessLink = Omit<EventLateAccessLink, 'id' | 'created_at' | 'revoked_at'>;

export type BookingUpdate = Partial<
  Pick<
    Booking,
    | 'event_id'
    | 'session_type_id'
    | 'starts_at'
    | 'ends_at'
    | 'timezone'
    | 'google_event_id'
    | 'address_line'
    | 'maps_url'
    | 'current_status'
    | 'notes'
  >
>;

export type ClientUpdate = Partial<Pick<Client, 'first_name' | 'last_name' | 'email' | 'phone'>>;

export type PaymentUpdate = Partial<
  Pick<Payment, 'status' | 'provider_payment_id' | 'invoice_url' | 'paid_at' | 'raw_payload'>
>;

// ── Shared helpers ──────────────────────────────────────────────────────────

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
