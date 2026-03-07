import type {
  Booking, BookingUpdate, NewBooking,
  Event,
  EventAttendee,
  EventRegistration, NewEventRegistration, RegistrationUpdate,
  FailureLog, NewFailureLog,
  JobRun, JobRunUpdate, NewJobRun,
  Payment, NewPayment, PaymentUpdate,
  TimeSlot,
} from '../../types.js';

/**
 * Generic persistence contract. Implementations must not leak driver-specific
 * types (no Supabase client, no Postgres row types) into this interface.
 */
export interface IRepository {
  // ── Bookings ────────────────────────────────────────────────────────────────

  createBooking(data: NewBooking): Promise<Booking>;
  getBookingById(id: string): Promise<Booking | null>;
  getBookingByConfirmTokenHash(hash: string): Promise<Booking | null>;
  getBookingByManageTokenHash(hash: string): Promise<Booking | null>;
  updateBooking(id: string, updates: BookingUpdate): Promise<Booking>;

  /**
   * Returns the start/end of bookings that are holding a slot right now:
   * status = 'pending_payment' (Pay Now) AND checkout_hold_expires_at > now,
   * OR status = 'pending_payment' | 'confirmed' | 'cash_ok' (Pay Later, already committed).
   * Used by the slots handler to exclude occupied windows.
   */
  getHeldSlots(from: string, to: string): Promise<TimeSlot[]>;

  // ── Events ──────────────────────────────────────────────────────────────────

  getPublishedEvents(): Promise<Event[]>;
  getEventBySlug(slug: string): Promise<Event | null>;
  getEventById(id: string): Promise<Event | null>;

  // ── Event registrations ─────────────────────────────────────────────────────

  createRegistration(data: NewEventRegistration, additionalAttendees: string[]): Promise<EventRegistration>;
  getRegistrationById(id: string): Promise<EventRegistration | null>;
  getRegistrationByConfirmTokenHash(hash: string): Promise<EventRegistration | null>;
  getRegistrationByManageTokenHash(hash: string): Promise<EventRegistration | null>;
  getAttendeesByRegistrationId(registrationId: string): Promise<EventAttendee[]>;
  updateRegistration(id: string, updates: RegistrationUpdate): Promise<EventRegistration>;
  countConfirmedRegistrations(eventId: string): Promise<number>;

  // ── Payments ────────────────────────────────────────────────────────────────

  createPayment(data: NewPayment): Promise<Payment>;
  getPaymentByStripeSessionId(sessionId: string): Promise<Payment | null>;
  updatePayment(id: string, updates: PaymentUpdate): Promise<Payment>;

  // ── Scheduled job queries ───────────────────────────────────────────────────

  getExpiredBookingHolds(): Promise<Booking[]>;
  getExpiredRegistrationHolds(): Promise<EventRegistration[]>;
  getUnconfirmedBookingFollowupsDue(): Promise<Booking[]>;
  getUnconfirmedRegistrationFollowupsDue(): Promise<EventRegistration[]>;
  getPaymentDueRemindersDue(): Promise<Booking[]>;
  getPaymentDueCancellationsDue(): Promise<Booking[]>;
  get24hBookingRemindersDue(): Promise<Booking[]>;
  get24hRegistrationRemindersDue(): Promise<EventRegistration[]>;

  // ── Observability ───────────────────────────────────────────────────────────

  logFailure(data: NewFailureLog): Promise<void>;
  getRecentFailureLogs(limit: number): Promise<FailureLog[]>;
  createJobRun(data: NewJobRun): Promise<JobRun>;
  updateJobRun(id: string, updates: JobRunUpdate): Promise<void>;
}
