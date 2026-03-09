import type {
  Booking,
  BookingSource,
  BookingUpdate,
  ContactMessage,
  Client,
  ClientUpdate,
  Event,
  EventLateAccessLink,
  EventReminderSubscription,
  FailureLog,
  NewBooking,
  NewClient,
  NewContactMessage,
  NewEventLateAccessLink,
  NewEventReminderSubscription,
  NewFailureLog,
  NewPayment,
  OrganizerBookingRow,
  Payment,
  PaymentUpdate,
  CalendarSyncFailure,
  CalendarSyncOperation,
  TimeSlot,
} from '../../types.js';

export interface OrganizerBookingFilters {
  source?: BookingSource;
  event_id?: string;
  date?: string; // YYYY-MM-DD
  client_id?: string;
  status?: string;
}

/**
 * Generic persistence contract. Implementations must not leak driver-specific
 * types (no Supabase client, no Postgres row types) into this interface.
 */
export interface IRepository {
  // ── Clients ───────────────────────────────────────────────────────────────

  createClient(data: NewClient): Promise<Client>;
  getClientById(id: string): Promise<Client | null>;
  getClientByEmail(email: string): Promise<Client | null>;
  updateClient(id: string, updates: ClientUpdate): Promise<Client>;

  // ── Bookings ───────────────────────────────────────────────────────────────

  createBooking(data: NewBooking): Promise<Booking>;
  getBookingById(id: string): Promise<Booking | null>;
  getBookingByConfirmTokenHash(hash: string): Promise<Booking | null>;
  getBookingByManageTokenHash(hash: string): Promise<Booking | null>;
  updateBooking(id: string, updates: BookingUpdate): Promise<Booking>;

  /**
   * Returns the start/end of session bookings that are currently holding a slot.
   */
  getHeldSlots(from: string, to: string): Promise<TimeSlot[]>;

  // ── Events ─────────────────────────────────────────────────────────────────

  getPublishedEvents(): Promise<Event[]>;
  getEventBySlug(slug: string): Promise<Event | null>;
  getEventById(id: string): Promise<Event | null>;
  countEventActiveBookings(eventId: string, nowIso: string): Promise<number>;

  // ── Event reminder subscriptions ───────────────────────────────────────────

  createOrUpdateEventReminderSubscription(
    data: NewEventReminderSubscription,
  ): Promise<EventReminderSubscription>;

  // ── Event late-access links ────────────────────────────────────────────────

  createEventLateAccessLink(data: NewEventLateAccessLink): Promise<EventLateAccessLink>;
  revokeActiveEventLateAccessLinks(eventId: string): Promise<number>;
  getEventLateAccessLinkByTokenHash(eventId: string, tokenHash: string): Promise<EventLateAccessLink | null>;
  getActiveEventLateAccessLinkForEvent(eventId: string, nowIso: string): Promise<EventLateAccessLink | null>;

  // ── Payments ───────────────────────────────────────────────────────────────

  createPayment(data: NewPayment): Promise<Payment>;
  getPaymentByBookingId(bookingId: string): Promise<Payment | null>;
  getPaymentByStripeSessionId(sessionId: string): Promise<Payment | null>;
  updatePayment(id: string, updates: PaymentUpdate): Promise<Payment>;

  // ── Contact form ───────────────────────────────────────────────────────────

  createContactMessage(data: NewContactMessage): Promise<ContactMessage>;

  // ── PA organizer reads/writes ──────────────────────────────────────────────

  getOrganizerBookings(filters: OrganizerBookingFilters): Promise<OrganizerBookingRow[]>;

  // ── Scheduled job queries ──────────────────────────────────────────────────

  getExpiredBookingHolds(): Promise<Booking[]>;
  getUnconfirmedBookingFollowupsDue(): Promise<Booking[]>;
  getPaymentDueRemindersDue(): Promise<Booking[]>;
  getPaymentDueCancellationsDue(): Promise<Booking[]>;
  get24hBookingRemindersDue(): Promise<Booking[]>;

  // ── Observability ──────────────────────────────────────────────────────────

  logFailure(data: NewFailureLog): Promise<void>;
  getRecentFailureLogs(limit: number): Promise<FailureLog[]>;

  // ── Calendar sync retry queue (backed by failure_logs) ────────────────────

  recordCalendarSyncFailure(input: {
    booking_id: string;
    operation: CalendarSyncOperation;
    error_message: string;
    request_id?: string | null;
    maxAttempts: number;
  }): Promise<CalendarSyncFailure>;
  getCalendarSyncFailuresDue(limit: number): Promise<CalendarSyncFailure[]>;
  resolveCalendarSyncFailure(
    bookingId: string,
    resolution?: 'resolved' | 'ignored',
    note?: string | null,
  ): Promise<void>;
}
