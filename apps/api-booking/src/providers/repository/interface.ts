import type {
  Booking,
  BookingCurrentStatus,
  BookingEffectIntent,
  BookingEventRecord,
  BookingEventSource,
  BookingEventType,
  BookingSideEffect,
  BookingSideEffectAttempt,
  BookingSideEffectEntity,
  BookingSideEffectStatus,
  BookingUpdate,
  Client,
  ClientUpdate,
  ContactMessage,
  Coupon,
  Event,
  EventLateAccessLink,
  EventReminderSubscription,
  NewBooking,
  NewBookingSideEffect,
  NewBookingSideEffectAttempt,
  NewClient,
  NewContactMessage,
  NewEventLateAccessLink,
  NewEventReminderSubscription,
  NewPayment,
  AdminContactMessageRow,
  OrganizerBookingRow,
  Payment,
  PaymentUpdate,
  SessionTypeRecord,
  EventUpdate,
  NewSessionType,
  NewSessionTypeAvailabilityWindow,
  NewSessionTypeWeekOverride,
  NewSystemSetting,
  SessionTypeUpdate,
  SessionTypeAvailabilityWindow,
  SessionTypeWeekOverride,
  SystemSetting,
  SystemSettingUpdate,
  TimeSlot,
} from '../../types.js';

export interface OrganizerBookingFilters {
  booking_kind?: 'event' | 'session';
  event_id?: string;
  date?: string; // YYYY-MM-DD
  client_id?: string;
  client_ids?: string[];
  current_status?: BookingCurrentStatus;
}

export interface AdminContactMessageFilters {
  date?: string; // YYYY-MM-DD
  client_id?: string;
  q?: string;
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
  listClientsByEmailPrefix(prefix: string): Promise<Client[]>;
  listBookingsByClientTagPrefix(prefix: string): Promise<Booking[]>;
  updateClient(id: string, updates: ClientUpdate): Promise<Client>;

  // ── Coupons ───────────────────────────────────────────────────────────────

  getCouponByCode(code: string): Promise<Coupon | null>;

  // ── Bookings ──────────────────────────────────────────────────────────────

  createBooking(data: NewBooking): Promise<Booking>;
  getBookingById(id: string): Promise<Booking | null>;
  getBookingByConfirmTokenHash(hash: string): Promise<Booking | null>;
  updateBooking(id: string, updates: BookingUpdate): Promise<Booking>;
  countClientBookingsBySessionType(
    clientId: string,
    sessionTypeId: string,
    excludedStatuses: BookingCurrentStatus[],
  ): Promise<number>;
  countClientActiveSessionBookingsInRange(
    clientId: string,
    startInclusiveIso: string,
    endExclusiveIso: string,
  ): Promise<number>;
  countActiveSessionTypeBookingsInRange(
    sessionTypeId: string,
    startInclusiveIso: string,
    endExclusiveIso: string,
    options?: { excludeBookingId?: string | null },
  ): Promise<number>;

  /** Returns start/end intervals that should currently block booking slots. */
  getHeldSlots(from: string, to: string): Promise<TimeSlot[]>;

  // ── Booking events ───────────────────────────────────────────────────────

  createBookingEvent(data: {
    booking_id: string;
    event_type: BookingEventType;
    source: BookingEventSource;
    payload?: Record<string, unknown>;
  }): Promise<BookingEventRecord>;

  listBookingEvents(bookingId: string): Promise<BookingEventRecord[]>;
  getBookingEventById(eventId: string): Promise<BookingEventRecord | null>;
  getLatestBookingEvent(bookingId: string): Promise<BookingEventRecord | null>;
  updateBookingEventCreatedAt(eventId: string, createdAt: string): Promise<BookingEventRecord>;

  // ── Booking side effects ────────────────────────────────────────────────

  createBookingSideEffects(effects: NewBookingSideEffect[]): Promise<BookingSideEffect[]>;

  getBookingSideEffectById(id: string): Promise<BookingSideEffect | null>;
  listBookingSideEffectsForEvent(eventId: string): Promise<BookingSideEffect[]>;

  getPendingBookingSideEffects(
    limit: number,
    nowIso: string,
  ): Promise<Array<BookingSideEffect & { booking_id: string }>>;
  deleteBookingSideEffect(id: string): Promise<void>;

  updateBookingSideEffect(
    id: string,
    updates: Partial<Pick<BookingSideEffect, 'status' | 'updated_at' | 'expires_at'>>,
  ): Promise<BookingSideEffect>;

  markStaleProcessingSideEffectsAsPending(nowIso: string): Promise<number>;

  // ── Booking side effect attempts ────────────────────────────────────────

  createBookingSideEffectAttempt(data: NewBookingSideEffectAttempt): Promise<BookingSideEffectAttempt>;
  listBookingSideEffectAttempts(sideEffectId: string): Promise<BookingSideEffectAttempt[]>;
  getLastBookingSideEffectAttempt(sideEffectId: string): Promise<BookingSideEffectAttempt | null>;

  // ── Events ───────────────────────────────────────────────────────────────

  getPublishedEvents(): Promise<Event[]>;
  getAllEvents(): Promise<Event[]>;
  getEventBySlug(slug: string): Promise<Event | null>;
  getEventById(id: string): Promise<Event | null>;
  updateEvent(id: string, updates: EventUpdate): Promise<Event>;
  countEventActiveBookings(eventId: string, nowIso: string): Promise<number>;

  // ── Event reminder subscriptions ────────────────────────────────────────

  createOrUpdateEventReminderSubscription(
    data: NewEventReminderSubscription,
  ): Promise<EventReminderSubscription>;

  // ── Event late-access links ─────────────────────────────────────────────

  createEventLateAccessLink(data: NewEventLateAccessLink): Promise<EventLateAccessLink>;
  revokeActiveEventLateAccessLinks(eventId: string): Promise<number>;
  getEventLateAccessLinkByTokenHash(eventId: string, tokenHash: string): Promise<EventLateAccessLink | null>;
  getActiveEventLateAccessLinkForEvent(eventId: string, nowIso: string): Promise<EventLateAccessLink | null>;

  // ── Payments ─────────────────────────────────────────────────────────────

  createPayment(data: NewPayment): Promise<Payment>;
  getPaymentByBookingId(bookingId: string): Promise<Payment | null>;
  getPaymentByStripeCheckoutSessionId(sessionId: string): Promise<Payment | null>;
  getPaymentByStripePaymentIntentId(paymentIntentId: string): Promise<Payment | null>;
  getPaymentByStripeInvoiceId(invoiceId: string): Promise<Payment | null>;
  getPaymentByStripeRefundId(refundId: string): Promise<Payment | null>;
  getPaymentByStripeCreditNoteId(creditNoteId: string): Promise<Payment | null>;
  updatePayment(id: string, updates: PaymentUpdate): Promise<Payment>;

  // ── Contact form ────────────────────────────────────────────────────────

  createContactMessage(data: NewContactMessage): Promise<ContactMessage>;

  // ── Organizer/admin reads ───────────────────────────────────────────────

  getOrganizerBookings(filters: OrganizerBookingFilters): Promise<OrganizerBookingRow[]>;
  getAdminContactMessages(filters: AdminContactMessageFilters): Promise<AdminContactMessageRow[]>;

  // ── Session types (offers) ──────────────────────────────────────────────

  getPublicSessionTypes(): Promise<SessionTypeRecord[]>;
  getAllSessionTypes(): Promise<SessionTypeRecord[]>;
  getSessionTypeById(id: string): Promise<SessionTypeRecord | null>;
  createSessionType(data: NewSessionType): Promise<SessionTypeRecord>;
  updateSessionType(id: string, updates: SessionTypeUpdate): Promise<SessionTypeRecord>;
  listSessionTypeAvailabilityWindows(sessionTypeId: string): Promise<SessionTypeAvailabilityWindow[]>;
  replaceSessionTypeAvailabilityWindows(
    sessionTypeId: string,
    windows: NewSessionTypeAvailabilityWindow[],
  ): Promise<SessionTypeAvailabilityWindow[]>;
  listSessionTypeWeekOverrides(
    sessionTypeId: string,
    weekStartDateFrom: string,
    weekStartDateTo: string,
  ): Promise<SessionTypeWeekOverride[]>;
  upsertSessionTypeWeekOverride(data: NewSessionTypeWeekOverride): Promise<SessionTypeWeekOverride>;

  // ── System settings ─────────────────────────────────────────────────────

  listSystemSettings(): Promise<SystemSetting[]>;
  listSystemSettingDomains(): Promise<string[]>;
  createSystemSetting(data: NewSystemSetting): Promise<SystemSetting>;
  updateSystemSetting(existingKeyname: string, updates: SystemSettingUpdate): Promise<SystemSetting>;
}

export function deriveBookingKind(booking: Pick<Booking, 'event_id'>): 'event' | 'session' {
  return booking.event_id ? 'event' : 'session';
}

export function sideEffectIsDispatchable(effect: Pick<BookingSideEffect, 'status' | 'expires_at'>, nowIso: string): boolean {
  if (effect.status !== 'PENDING') return false;
  if (!effect.expires_at) return true;
  return new Date(effect.expires_at).getTime() <= new Date(nowIso).getTime();
}

export function sideEffectStatusAfterAttempt(
  attemptStatus: 'SUCCESS' | 'FAILED',
  attemptNum: number,
  maxAttempts: number,
): BookingSideEffectStatus {
  if (attemptStatus === 'SUCCESS') return 'SUCCESS';
  return attemptNum >= Math.max(1, maxAttempts) ? 'DEAD' : 'FAILED';
}

export function inferEntityFromIntent(intent: BookingEffectIntent): BookingSideEffectEntity {
  if (intent.startsWith('SEND_')) return intent.includes('WHATSAPP') ? 'WHATSAPP' : 'EMAIL';
  if (intent.includes('STRIPE') || intent.includes('PAYMENT')) return 'PAYMENT';
  if (intent.includes('CALENDAR')) return 'CALENDAR';
  return 'SYSTEM';
}
