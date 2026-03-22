export type BookingType = 'FREE' | 'PAY_NOW' | 'PAY_LATER';
export type MeetingProvider = 'google_meet' | 'zoom';

// ── Booking domain enums ────────────────────────────────────────────────────

export type BookingCurrentStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'EXPIRED'
  | 'CANCELED'
  | 'COMPLETED'
  | 'NO_SHOW';

export type BookingEventType =
  | 'BOOKING_FORM_SUBMITTED'
  | 'BOOKING_RESCHEDULED'
  | 'BOOKING_EXPIRED'
  | 'BOOKING_CANCELED'
  | 'PAYMENT_SETTLED'
  | 'REFUND_COMPLETED';

export type BookingEventSource = 'PUBLIC_UI' | 'ADMIN_UI' | 'SYSTEM' | 'WEBHOOK';
export type BookingEventStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';

export type BookingSideEffectEntity = 'EMAIL' | 'CALENDAR' | 'PAYMENT' | 'WHATSAPP' | 'SYSTEM';

export type BookingSideEffectStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'DEAD';

export type BookingSideEffectAttemptStatus = 'PROCESSING' | 'SUCCESS' | 'FAILED';

export type BookingEffectIntent =
  | 'SEND_BOOKING_CONFIRMATION_REQUEST'
  | 'SEND_BOOKING_CONFIRMATION'
  | 'SEND_BOOKING_REFUND_CONFIRMATION'
  | 'SEND_PAYMENT_LINK'
  | 'SEND_PAYMENT_REMINDER'
  | 'SEND_BOOKING_CANCELLATION_CONFIRMATION'
  | 'SEND_BOOKING_EXPIRATION_NOTIFICATION'
  | 'SEND_EVENT_REMINDER'
  | 'CREATE_STRIPE_CHECKOUT'
  | 'VERIFY_EMAIL_CONFIRMATION'
  | 'VERIFY_STRIPE_PAYMENT'
  | 'CREATE_STRIPE_REFUND'
  | 'RESERVE_CALENDAR_SLOT'
  | 'UPDATE_CALENDAR_SLOT'
  | 'CANCEL_CALENDAR_SLOT';

// ── Other domain enums ──────────────────────────────────────────────────────

export type EventStatus = 'draft' | 'published' | 'cancelled' | 'sold_out';
export type PaymentStatus = 'PENDING' | 'INVOICE_SENT' | 'CASH_OK' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
export type RefundStatus = 'NONE' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
export type PaymentProvider = 'stripe' | 'mock';
export type SystemSettingValueType = 'integer' | 'float' | 'boolean' | 'text' | 'json';

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
  booking_type: BookingType;
  starts_at: string;
  ends_at: string;
  timezone: string;
  google_event_id: string | null;
  meeting_provider?: MeetingProvider | null;
  meeting_link?: string | null;
  address_line: string;
  maps_url: string;
  price: number;
  currency: string;
  coupon_code: string | null;
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
  status: BookingEventStatus;
  payload: Record<string, unknown>;
  error_message: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
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
  updated_at: string;
  completed_at: string | null;
}

export interface Event {
  id: string;
  slug: string;
  title: string;
  description: string;
  marketing_content: EventMarketingContent | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  location_name: string | null;
  address_line: string;
  maps_url: string;
  is_paid: boolean;
  price_per_person: number | null;
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

export interface EventMarketingContent {
  subtitle?: string;
  intro?: string;
  what_to_expect?: string[];
  takeaways?: string[];
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

export interface SystemSetting {
  domain: string;
  keyname: string;
  readable_name: string;
  value_type: SystemSettingValueType;
  unit: string | null;
  value: string;
  description: string;
  description_he: string | null;
  created_at: string;
  updated_at: string;
}

export interface Coupon {
  code: string;
  discount_percent: number;
}

// ── Session types (offers) ─────────────────────────────────────────────────

export type SessionTypeStatus = 'draft' | 'active' | 'hidden';
export type SessionTypeAvailabilityMode = 'shared_default' | 'dedicated';
export type SessionTypeWeekOverrideMode = 'AUTO' | 'FORCE_OPEN' | 'FORCE_CLOSED';

export interface SessionTypeRecord {
  id: string;
  title: string;
  slug: string;
  short_description: string | null;
  description: string;
  duration_minutes: number;
  price: number;
  currency: string;
  status: SessionTypeStatus;
  sort_order: number;
  image_key: string | null;
  drive_file_id: string | null;
  image_alt: string | null;
  availability_mode: SessionTypeAvailabilityMode;
  availability_timezone: string | null;
  weekly_booking_limit: number | null;
  slot_step_minutes: number | null;
  created_at: string;
  updated_at: string;
}

export interface SessionTypeAvailabilityWindow {
  id: string;
  session_type_id: string;
  weekday_iso: number;
  start_local_time: string;
  end_local_time: string;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface NewSessionTypeAvailabilityWindow {
  session_type_id: string;
  weekday_iso: number;
  start_local_time: string;
  end_local_time: string;
  sort_order: number;
  active: boolean;
}

export interface SessionTypeWeekOverride {
  session_type_id: string;
  week_start_date: string;
  mode: SessionTypeWeekOverrideMode;
  override_weekly_booking_limit: number | null;
  note: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewSessionTypeWeekOverride {
  session_type_id: string;
  week_start_date: string;
  mode: SessionTypeWeekOverrideMode;
  override_weekly_booking_limit: number | null;
  note: string | null;
  updated_by: string | null;
}

export type EventUpdate = Partial<Pick<Event,
  | 'slug'
  | 'title'
  | 'description'
  | 'marketing_content'
  | 'starts_at'
  | 'ends_at'
  | 'timezone'
  | 'location_name'
  | 'address_line'
  | 'maps_url'
  | 'is_paid'
  | 'price_per_person'
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
    | 'availability_mode'
    | 'availability_timezone'
    | 'weekly_booking_limit'
    | 'slot_step_minutes'
  >
>;

export type NewSystemSetting = Omit<SystemSetting, 'created_at' | 'updated_at'>;

export type SystemSettingUpdate = Partial<
  Pick<
    SystemSetting,
    | 'domain'
    | 'keyname'
    | 'readable_name'
    | 'value_type'
    | 'unit'
    | 'value'
    | 'description'
    | 'description_he'
  >
>;

export interface ContactMessage {
  id: string;
  client_id: string;
  topic: string | null;
  message: string;
  status: 'NEW' | 'HANDLED' | 'ARCHIVED' | 'SPAM';
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  booking_id: string;
  provider: PaymentProvider;
  amount: number;
  currency: string;
  status: PaymentStatus;
  checkout_url: string | null;
  invoice_url: string | null;
  raw_payload: Record<string, unknown> | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
  stripe_customer_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  stripe_payment_link_id: string | null;
  stripe_receipt_url?: string | null;
  refund_status?: RefundStatus | null;
  refund_amount?: number | null;
  refund_currency?: string | null;
  stripe_refund_id?: string | null;
  stripe_credit_note_id?: string | null;
  stripe_credit_note_url?: string | null;
  refunded_at?: string | null;
  refund_reason?: string | null;
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
  booking_price: number | null;
  booking_currency: string | null;
  booking_coupon_code: string | null;
  payment_amount: number | null;
  payment_currency: string | null;
  payment_status: PaymentStatus | null;
  payment_provider: PaymentProvider | null;
  payment_checkout_url: string | null;
  payment_invoice_url: string | null;
  payment_refund_status: RefundStatus | null;
  payment_refund_amount: number | null;
  payment_refund_currency: string | null;
  payment_stripe_customer_id: string | null;
  payment_stripe_checkout_session_id: string | null;
  payment_stripe_payment_intent_id: string | null;
  payment_stripe_invoice_id: string | null;
  payment_stripe_payment_link_id: string | null;
  payment_stripe_refund_id: string | null;
  payment_stripe_credit_note_id: string | null;
  payment_stripe_receipt_url: string | null;
  payment_stripe_credit_note_url: string | null;
  payment_paid_at: string | null;
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

export interface AdminContactMessageRow {
  id: string;
  client_id: string;
  topic: string | null;
  message: string;
  status: ContactMessage['status'];
  source: string;
  created_at: string;
  updated_at: string;
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

export type NewBookingEvent = Omit<BookingEventRecord, 'id' | 'created_at' | 'updated_at'>;
export type NewBookingSideEffect = Omit<BookingSideEffect, 'id' | 'created_at' | 'updated_at'>;
export type NewBookingSideEffectAttempt = Omit<BookingSideEffectAttempt, 'id' | 'created_at' | 'updated_at'>;

export type NewPayment = Omit<Payment, 'id' | 'created_at' | 'updated_at'>;
export type NewContactMessage = Omit<ContactMessage, 'id' | 'created_at' | 'updated_at'>;
export type NewEventReminderSubscription = Omit<EventReminderSubscription, 'id' | 'created_at'>;
export type NewEventLateAccessLink = Omit<EventLateAccessLink, 'id' | 'created_at' | 'revoked_at'>;

export type BookingUpdate = Partial<
  Pick<
    Booking,
    | 'event_id'
    | 'session_type_id'
    | 'booking_type'
    | 'starts_at'
    | 'ends_at'
    | 'timezone'
    | 'google_event_id'
    | 'meeting_provider'
    | 'meeting_link'
    | 'address_line'
    | 'maps_url'
    | 'price'
    | 'currency'
    | 'coupon_code'
    | 'current_status'
    | 'notes'
  >
>;

export type ClientUpdate = Partial<Pick<Client, 'first_name' | 'last_name' | 'email' | 'phone'>>;

export type PaymentUpdate = Partial<
  Pick<
    Payment,
    | 'status'
    | 'amount'
    | 'currency'
    | 'checkout_url'
    | 'invoice_url'
    | 'paid_at'
    | 'raw_payload'
    | 'stripe_customer_id'
    | 'stripe_checkout_session_id'
    | 'stripe_payment_intent_id'
    | 'stripe_invoice_id'
    | 'stripe_payment_link_id'
    | 'stripe_receipt_url'
    | 'refund_status'
    | 'refund_amount'
    | 'refund_currency'
    | 'stripe_refund_id'
    | 'stripe_credit_note_id'
    | 'stripe_credit_note_url'
    | 'refunded_at'
    | 'refund_reason'
  >
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
