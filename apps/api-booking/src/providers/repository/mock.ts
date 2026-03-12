import { mockState } from '../mock-state.js';
import type { OrganizerBookingFilters, IRepository } from './interface.js';
import { SIDE_EFFECT_PROCESSING_TIMEOUT_MINUTES } from './interface.js';
import type {
  Booking,
  BookingEventRecord,
  BookingSideEffect,
  BookingSideEffectAttempt,
  BookingUpdate,
  Client,
  ClientUpdate,
  ContactMessage,
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
  OrganizerBookingRow,
  Payment,
  PaymentUpdate,
  SessionTypeRecord,
  NewSessionType,
  SessionTypeUpdate,
  TimeSlot,
} from '../../types.js';

const now = () => new Date().toISOString();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class MockRepository implements IRepository {
  // ── Clients ───────────────────────────────────────────────────────────────

  async createClient(data: NewClient): Promise<Client> {
    const client: Client = {
      ...data,
      email: normalizeEmail(data.email),
      id: crypto.randomUUID(),
      created_at: now(),
      updated_at: now(),
    };
    mockState.clients.set(client.id, client);
    return client;
  }

  async getClientById(id: string): Promise<Client | null> {
    return mockState.clients.get(id) ?? null;
  }

  async getClientByEmail(email: string): Promise<Client | null> {
    const normalized = normalizeEmail(email);
    for (const client of mockState.clients.values()) {
      if (normalizeEmail(client.email) === normalized) return client;
    }
    return null;
  }

  async updateClient(id: string, updates: ClientUpdate): Promise<Client> {
    const existing = mockState.clients.get(id);
    if (!existing) throw new Error(`Client ${id} not found`);
    const updated: Client = {
      ...existing,
      ...updates,
      ...(updates.email ? { email: normalizeEmail(updates.email) } : {}),
      updated_at: now(),
    };
    mockState.clients.set(id, updated);
    return updated;
  }

  // ── Bookings ──────────────────────────────────────────────────────────────

  async createBooking(data: NewBooking): Promise<Booking> {
    const booking: Booking = {
      ...data,
      id: crypto.randomUUID(),
      created_at: now(),
      updated_at: now(),
    };
    mockState.bookings.set(booking.id, booking);
    return this.hydrateBooking(booking);
  }

  async getBookingById(id: string): Promise<Booking | null> {
    const booking = mockState.bookings.get(id);
    return booking ? this.hydrateBooking(booking) : null;
  }

  async getBookingByConfirmTokenHash(hash: string): Promise<Booking | null> {
    const matchingEvent = [...mockState.bookingEvents]
      .reverse()
      .find((event) => event.payload?.['confirm_token_hash'] === hash);

    if (!matchingEvent) return null;
    const booking = mockState.bookings.get(matchingEvent.booking_id);
    return booking ? this.hydrateBooking(booking) : null;
  }

  async updateBooking(id: string, updates: BookingUpdate): Promise<Booking> {
    const existing = mockState.bookings.get(id);
    if (!existing) throw new Error(`Booking ${id} not found`);
    const updated: Booking = {
      ...existing,
      ...updates,
      updated_at: now(),
    };
    mockState.bookings.set(id, updated);
    return this.hydrateBooking(updated);
  }

  async getHeldSlots(from: string, to: string): Promise<TimeSlot[]> {
    const fromMs = new Date(`${from}T00:00:00Z`).getTime();
    const toMs = new Date(`${to}T23:59:59Z`).getTime();

    return [...mockState.bookings.values()]
      .filter((booking) => {
        if (booking.event_id) return false;
        if (booking.current_status === 'EXPIRED' || booking.current_status === 'CANCELED' || booking.current_status === 'COMPLETED' || booking.current_status === 'NO_SHOW' || booking.current_status === 'REFUNDED') {
          return false;
        }
        const startMs = new Date(booking.starts_at).getTime();
        const endMs = new Date(booking.ends_at).getTime();
        return !(endMs < fromMs || startMs > toMs);
      })
      .map((booking) => ({ start: booking.starts_at, end: booking.ends_at }));
  }

  // ── Booking events ────────────────────────────────────────────────────────

  async createBookingEvent(data: {
    booking_id: string;
    event_type: BookingEventRecord['event_type'];
    source: BookingEventRecord['source'];
    payload?: Record<string, unknown>;
  }): Promise<BookingEventRecord> {
    const event: BookingEventRecord = {
      id: crypto.randomUUID(),
      booking_id: data.booking_id,
      event_type: data.event_type,
      source: data.source,
      payload: data.payload ?? {},
      created_at: now(),
    };
    mockState.bookingEvents.push(event);
    return event;
  }

  async listBookingEvents(bookingId: string): Promise<BookingEventRecord[]> {
    return mockState.bookingEvents
      .filter((event) => event.booking_id === bookingId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  async getBookingEventById(eventId: string): Promise<BookingEventRecord | null> {
    return mockState.bookingEvents.find((event) => event.id === eventId) ?? null;
  }

  async getLatestBookingEvent(bookingId: string): Promise<BookingEventRecord | null> {
    const events = await this.listBookingEvents(bookingId);
    return events.length > 0 ? events[events.length - 1]! : null;
  }

  // ── Booking side effects ─────────────────────────────────────────────────

  async createBookingSideEffects(effects: NewBookingSideEffect[]): Promise<BookingSideEffect[]> {
    const rows: BookingSideEffect[] = [];

    for (const effect of effects) {
      const event = mockState.bookingEvents.find((candidate) => candidate.id === effect.booking_event_id);
      if (!event) {
        throw new Error(`Booking event ${effect.booking_event_id} not found`);
      }

      const row: BookingSideEffect & { booking_id: string } = {
        id: crypto.randomUUID(),
        booking_event_id: effect.booking_event_id,
        booking_id: event.booking_id,
        entity: effect.entity,
        effect_intent: effect.effect_intent,
        status: effect.status,
        expires_at: effect.expires_at,
        max_attempts: effect.max_attempts,
        created_at: now(),
        updated_at: now(),
      };

      mockState.sideEffects.push(row);
      rows.push(stripBookingId(row));
    }

    return rows;
  }

  async getBookingSideEffectById(id: string): Promise<BookingSideEffect | null> {
    const row = mockState.sideEffects.find((effect) => effect.id === id);
    return row ? stripBookingId(row) : null;
  }

  async getPendingBookingSideEffects(
    limit: number,
    _nowIso: string,
  ): Promise<Array<BookingSideEffect & { booking_id: string }>> {
    return mockState.sideEffects
      .filter((effect) => effect.status === 'pending' || effect.status === 'failed')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(0, Math.max(1, limit));
  }

  async updateBookingSideEffect(
    id: string,
    updates: Partial<Pick<BookingSideEffect, 'status' | 'updated_at'>>,
  ): Promise<BookingSideEffect> {
    const row = mockState.sideEffects.find((effect) => effect.id === id);
    if (!row) throw new Error(`Side effect ${id} not found`);

    row.status = updates.status ?? row.status;
    row.updated_at = updates.updated_at ?? now();
    return stripBookingId(row);
  }

  async markStaleProcessingSideEffectsAsPending(nowIso: string): Promise<number> {
    const thresholdMs = new Date(nowIso).getTime() - SIDE_EFFECT_PROCESSING_TIMEOUT_MINUTES * 60_000;
    let resetCount = 0;

    for (const effect of mockState.sideEffects) {
      if (effect.status !== 'processing') continue;
      if (new Date(effect.updated_at).getTime() > thresholdMs) continue;
      effect.status = 'pending';
      effect.updated_at = nowIso;
      resetCount += 1;
    }

    return resetCount;
  }

  // ── Booking side effect attempts ─────────────────────────────────────────

  async createBookingSideEffectAttempt(data: NewBookingSideEffectAttempt): Promise<BookingSideEffectAttempt> {
    const attempt: BookingSideEffectAttempt = {
      id: crypto.randomUUID(),
      booking_side_effect_id: data.booking_side_effect_id,
      attempt_num: data.attempt_num,
      api_log_id: data.api_log_id,
      status: data.status,
      error_message: data.error_message,
      created_at: now(),
    };
    mockState.sideEffectAttempts.push(attempt);
    return attempt;
  }

  async listBookingSideEffectAttempts(sideEffectId: string): Promise<BookingSideEffectAttempt[]> {
    return mockState.sideEffectAttempts
      .filter((attempt) => attempt.booking_side_effect_id === sideEffectId)
      .sort((a, b) => a.attempt_num - b.attempt_num);
  }

  async getLastBookingSideEffectAttempt(sideEffectId: string): Promise<BookingSideEffectAttempt | null> {
    const attempts = await this.listBookingSideEffectAttempts(sideEffectId);
    return attempts.length > 0 ? attempts[attempts.length - 1]! : null;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  async getPublishedEvents(): Promise<Event[]> {
    return [...mockState.events.values()]
      .filter((event) => event.status === 'published')
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }

  async getAllEvents(): Promise<Event[]> {
    return [...mockState.events.values()].sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  }

  async updateEvent(id: string, updates: import('../../types.js').EventUpdate): Promise<Event> {
    const event = mockState.events.get(id);
    if (!event) throw new Error(`Event ${id} not found`);
    const updated = { ...event, ...updates, updated_at: new Date().toISOString() };
    mockState.events.set(id, updated);
    return updated;
  }

  async getEventBySlug(slug: string): Promise<Event | null> {
    for (const event of mockState.events.values()) {
      if (event.slug === slug) return event;
    }
    return null;
  }

  async getEventById(id: string): Promise<Event | null> {
    return mockState.events.get(id) ?? null;
  }

  async countEventActiveBookings(eventId: string, _nowIso: string): Promise<number> {
    let count = 0;

    for (const booking of mockState.bookings.values()) {
      if (booking.event_id !== eventId) continue;
      if (booking.current_status === 'EXPIRED' || booking.current_status === 'CANCELED' || booking.current_status === 'COMPLETED' || booking.current_status === 'NO_SHOW' || booking.current_status === 'REFUNDED') {
        continue;
      }
      count += 1;
    }

    return count;
  }

  // ── Event reminder subscriptions ──────────────────────────────────────────

  async createOrUpdateEventReminderSubscription(
    data: NewEventReminderSubscription,
  ): Promise<EventReminderSubscription> {
    const normalizedEmail = normalizeEmail(data.email);
    const family = data.event_family.trim() || 'illuminate_evenings';

    for (const existing of mockState.eventReminderSubscriptions.values()) {
      if (normalizeEmail(existing.email) === normalizedEmail && existing.event_family === family) {
        const updated: EventReminderSubscription = {
          ...existing,
          email: normalizedEmail,
          first_name: data.first_name,
          last_name: data.last_name,
          phone: data.phone,
        };
        mockState.eventReminderSubscriptions.set(updated.id, updated);
        return updated;
      }
    }

    const created: EventReminderSubscription = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      first_name: data.first_name,
      last_name: data.last_name,
      phone: data.phone,
      event_family: family,
      created_at: now(),
    };
    mockState.eventReminderSubscriptions.set(created.id, created);
    return created;
  }

  // ── Event late-access links ───────────────────────────────────────────────

  async createEventLateAccessLink(data: NewEventLateAccessLink): Promise<EventLateAccessLink> {
    const created: EventLateAccessLink = {
      ...data,
      id: crypto.randomUUID(),
      created_at: now(),
      revoked_at: null,
    };
    mockState.eventLateAccessLinks.set(created.id, created);
    return created;
  }

  async revokeActiveEventLateAccessLinks(eventId: string): Promise<number> {
    let affected = 0;
    for (const link of mockState.eventLateAccessLinks.values()) {
      if (link.event_id === eventId && link.revoked_at === null) {
        link.revoked_at = now();
        affected += 1;
      }
    }
    return affected;
  }

  async getEventLateAccessLinkByTokenHash(eventId: string, tokenHash: string): Promise<EventLateAccessLink | null> {
    for (const link of mockState.eventLateAccessLinks.values()) {
      if (link.event_id === eventId && link.token_hash === tokenHash) return link;
    }
    return null;
  }

  async getActiveEventLateAccessLinkForEvent(eventId: string, nowIso: string): Promise<EventLateAccessLink | null> {
    const nowMs = new Date(nowIso).getTime();
    const candidates = [...mockState.eventLateAccessLinks.values()]
      .filter((link) =>
        link.event_id === eventId &&
        link.revoked_at === null &&
        new Date(link.expires_at).getTime() > nowMs,
      )
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return candidates[0] ?? null;
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  async createPayment(data: NewPayment): Promise<Payment> {
    const payment: Payment = {
      ...data,
      id: crypto.randomUUID(),
      created_at: now(),
      updated_at: now(),
    };
    mockState.payments.set(payment.id, payment);
    return payment;
  }

  async getPaymentByBookingId(bookingId: string): Promise<Payment | null> {
    const matches = [...mockState.payments.values()]
      .filter((payment) => payment.booking_id === bookingId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return matches[0] ?? null;
  }

  async getPaymentByStripeSessionId(sessionId: string): Promise<Payment | null> {
    for (const payment of mockState.payments.values()) {
      if (payment.provider_payment_id === sessionId) return payment;
    }
    return null;
  }

  async updatePayment(id: string, updates: PaymentUpdate): Promise<Payment> {
    const existing = mockState.payments.get(id);
    if (!existing) throw new Error(`Payment ${id} not found`);
    const updated: Payment = {
      ...existing,
      ...updates,
      updated_at: now(),
    };
    mockState.payments.set(id, updated);
    return updated;
  }

  // ── Contact form ──────────────────────────────────────────────────────────

  async createContactMessage(data: NewContactMessage): Promise<ContactMessage> {
    const created: ContactMessage = {
      ...data,
      id: crypto.randomUUID(),
      created_at: now(),
      updated_at: now(),
    };
    mockState.contactMessages.set(created.id, created);
    return created;
  }

  // ── Organizer reads ───────────────────────────────────────────────────────

  async getOrganizerBookings(filters: OrganizerBookingFilters): Promise<OrganizerBookingRow[]> {
    const rows: OrganizerBookingRow[] = [];

    for (const booking of mockState.bookings.values()) {
      const hydrated = this.hydrateBooking(booking);
      const bookingKind = hydrated.event_id ? 'event' : 'session';

      if (filters.booking_kind && bookingKind !== filters.booking_kind) continue;
      if (filters.event_id && hydrated.event_id !== filters.event_id) continue;
      if (filters.client_id && hydrated.client_id !== filters.client_id) continue;
      if (filters.current_status && hydrated.current_status !== filters.current_status) continue;
      if (filters.date && hydrated.starts_at.slice(0, 10) !== filters.date) continue;

      const client = mockState.clients.get(hydrated.client_id);
      if (!client) continue;
      const event = hydrated.event_id ? mockState.events.get(hydrated.event_id) : null;
      const payment = [...mockState.payments.values()]
        .filter((entry) => entry.booking_id === hydrated.id)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null;
      const bookingEvents = [...mockState.bookingEvents]
        .filter((entry) => entry.booking_id === hydrated.id)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const latestEvent = bookingEvents[0] ?? null;
      const latestPaymentEvent = bookingEvents.find((entry) =>
        entry.event_type === 'PAYMENT_SETTLED'
        || entry.event_type === 'REFUND_REQUESTED'
        || entry.event_type === 'REFUND_CREATED'
        || entry.event_type === 'REFUND_VERIFIED',
      ) ?? null;

      const eventIds = new Set(bookingEvents.map((entry) => entry.id));
      const sideEffects = mockState.sideEffects
        .filter((entry) => eventIds.has(entry.booking_event_id))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const sideEffectIds = new Set(sideEffects.map((entry) => entry.id));
      const paymentSideEffectIds = new Set(
        sideEffects
          .filter((entry) => entry.effect_intent.includes('stripe') || entry.effect_intent.includes('payment'))
          .map((entry) => entry.id),
      );
      const attempts = [...mockState.sideEffectAttempts]
        .filter((entry) => sideEffectIds.has(entry.booking_side_effect_id))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const latestAttempt = attempts[0] ?? null;
      const latestPaymentAttempt = attempts.find((entry) => paymentSideEffectIds.has(entry.booking_side_effect_id)) ?? null;

      rows.push({
        booking_id: hydrated.id,
        current_status: hydrated.current_status,
        event_id: hydrated.event_id,
        event_title: event?.title ?? null,
        session_type_id: hydrated.session_type_id,
        session_type_title: findSessionTypeTitle(hydrated.session_type_id),
        starts_at: hydrated.starts_at,
        ends_at: hydrated.ends_at,
        timezone: hydrated.timezone,
        google_event_id: hydrated.google_event_id,
        address_line: hydrated.address_line,
        maps_url: hydrated.maps_url,
        payment_amount_cents: payment?.amount_cents ?? null,
        payment_currency: payment?.currency ?? null,
        payment_status: payment?.status ?? null,
        latest_event_type: latestEvent?.event_type ?? null,
        latest_event_at: latestEvent?.created_at ?? null,
        latest_side_effect_attempt_status: latestAttempt?.status ?? null,
        latest_side_effect_attempt_at: latestAttempt?.created_at ?? null,
        payment_latest_event_type: latestPaymentEvent?.event_type ?? null,
        payment_latest_event_at: latestPaymentEvent?.created_at ?? null,
        payment_latest_side_effect_attempt_status: latestPaymentAttempt?.status ?? null,
        payment_latest_side_effect_attempt_at: latestPaymentAttempt?.created_at ?? null,
        notes: hydrated.notes,
        created_at: hydrated.created_at,
        updated_at: hydrated.updated_at,
        client_id: client.id,
        client_first_name: client.first_name,
        client_last_name: client.last_name,
        client_email: client.email,
        client_phone: client.phone,
      });
    }

    rows.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
    return rows;
  }

  // ── Session types (offers) ───────────────────────────────────────────────

  async getPublicSessionTypes(): Promise<SessionTypeRecord[]> {
    return MOCK_SESSION_TYPES.filter((sessionType) => sessionType.status === 'active');
  }

  async getAllSessionTypes(): Promise<SessionTypeRecord[]> {
    return [...MOCK_SESSION_TYPES];
  }

  async createSessionType(data: NewSessionType): Promise<SessionTypeRecord> {
    const record: SessionTypeRecord = {
      ...data,
      id: `mock-${Date.now().toString(36)}`,
      created_at: now(),
      updated_at: now(),
    };
    MOCK_SESSION_TYPES.push(record);
    return record;
  }

  async updateSessionType(id: string, updates: SessionTypeUpdate): Promise<SessionTypeRecord> {
    const index = MOCK_SESSION_TYPES.findIndex((sessionType) => sessionType.id === id);
    if (index === -1) throw new Error(`Session type ${id} not found`);
    MOCK_SESSION_TYPES[index] = {
      ...MOCK_SESSION_TYPES[index]!,
      ...updates,
      updated_at: now(),
    };
    return MOCK_SESSION_TYPES[index]!;
  }

  private hydrateBooking(booking: Booking): Booking {
    const client = mockState.clients.get(booking.client_id);
    const event = booking.event_id ? mockState.events.get(booking.event_id) : null;
    if (!client) return booking;
    return {
      ...booking,
      client_first_name: client.first_name,
      client_last_name: client.last_name,
      client_email: client.email,
      client_phone: client.phone,
      event_title: event?.title ?? null,
      session_type_title: findSessionTypeTitle(booking.session_type_id),
    };
  }
}

const MOCK_SESSION_TYPES: SessionTypeRecord[] = [
  {
    id: 'mock-st-1',
    title: 'Introductory Clarity Conversation',
    slug: 'intro-clarity-conversation',
    short_description: 'A space to assess alignment — no commitment required.',
    description: 'We meet to assess alignment. No commitment required. A space to explore whether this is the right fit for you. Format: Online or in person · Lugano.',
    duration_minutes: 45,
    price: 0,
    currency: 'CHF',
    status: 'active',
    sort_order: 1,
    image_key: null,
    drive_file_id: null,
    image_alt: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'mock-st-2',
    title: 'First Clarity Session',
    slug: 'first-clarity-session',
    short_description: 'Where your story, values, and patterns come fully into view.',
    description: 'An extended session to map where you are, what is blocking you, and what you truly want. This becomes the foundation everything else is built on. Format: Online or in person · Lugano.',
    duration_minutes: 90,
    price: 15000,
    currency: 'CHF',
    status: 'active',
    sort_order: 2,
    image_key: null,
    drive_file_id: null,
    image_alt: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'mock-st-3',
    title: 'Cycle Session',
    slug: 'cycle-session',
    short_description: 'Focused, structured work within an ongoing Clarity Cycle.',
    description: 'Seven sessions per cycle, each building on the last — unpacking what is stuck and practicing the new you. On the final session we reassess whether to pause or begin a new cycle. Format: Online or in person · Lugano.',
    duration_minutes: 60,
    price: 12000,
    currency: 'CHF',
    status: 'active',
    sort_order: 3,
    image_key: null,
    drive_file_id: null,
    image_alt: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'mock-st-4',
    title: 'Clarity from your Guardian Angels',
    slug: 'clarity-from-guardian-angels',
    short_description: 'A fresh perspective from the eyes of unconditional love.',
    description: 'In this session we will connect with your guardian angels and translate their messages to illuminate your current situation with new clarity and remind you they are always here for you. Format: Online or in person · Lugano.',
    duration_minutes: 90,
    price: 15000,
    currency: 'CHF',
    status: 'active',
    sort_order: 4,
    image_key: null,
    drive_file_id: null,
    image_alt: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

function stripBookingId(effect: BookingSideEffect & { booking_id: string }): BookingSideEffect {
  const { booking_id: _bookingId, ...rest } = effect;
  return rest;
}

function findSessionTypeTitle(sessionTypeId: string | null): string | null {
  if (!sessionTypeId) return null;
  const row = MOCK_SESSION_TYPES.find((sessionType) => sessionType.id === sessionTypeId);
  return row?.title ?? null;
}
