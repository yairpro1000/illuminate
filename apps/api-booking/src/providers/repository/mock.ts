import { mockState } from '../mock-state.js';
import type { OrganizerBookingFilters, IRepository } from './interface.js';
import type {
  Booking,
  BookingUpdate,
  Client,
  ClientUpdate,
  ContactMessage,
  Event,
  EventLateAccessLink,
  EventReminderSubscription,
  CalendarSyncFailure,
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
  TimeSlot,
} from '../../types.js';

const now = () => new Date().toISOString();
const CALENDAR_SYNC_OPERATION = 'calendar_sync';

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
    for (const c of mockState.clients.values()) {
      if (normalizeEmail(c.email) === normalized) return c;
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
    const booking: Booking = { ...data, id: crypto.randomUUID(), created_at: now(), updated_at: now() };
    mockState.bookings.set(booking.id, booking);
    return this.hydrateBooking(booking);
  }

  async getBookingById(id: string): Promise<Booking | null> {
    const booking = mockState.bookings.get(id);
    return booking ? this.hydrateBooking(booking) : null;
  }

  async getBookingByConfirmTokenHash(hash: string): Promise<Booking | null> {
    for (const b of mockState.bookings.values()) {
      if (b.confirm_token_hash === hash) return this.hydrateBooking(b);
    }
    return null;
  }

  async getBookingByManageTokenHash(hash: string): Promise<Booking | null> {
    for (const b of mockState.bookings.values()) {
      if (b.manage_token_hash === hash) return this.hydrateBooking(b);
    }
    return null;
  }

  async updateBooking(id: string, updates: BookingUpdate): Promise<Booking> {
    const existing = mockState.bookings.get(id);
    if (!existing) throw new Error(`Booking ${id} not found`);
    const updated: Booking = { ...existing, ...updates, updated_at: now() };
    mockState.bookings.set(id, updated);
    return this.hydrateBooking(updated);
  }

  async getHeldSlots(from: string, to: string): Promise<TimeSlot[]> {
    const fromMs = new Date(`${from}T00:00:00Z`).getTime();
    const toMs = new Date(`${to}T23:59:59Z`).getTime();
    const holdNow = Date.now();
    const slots: TimeSlot[] = [];

    for (const b of mockState.bookings.values()) {
      if (b.source !== 'session') continue;

      const start = new Date(b.starts_at).getTime();
      const end = new Date(b.ends_at).getTime();
      if (end < fromMs || start > toMs) continue;

      if (b.status === 'pending_payment') {
        // Pay-now hold (and paid event checkout holds) only reserve while hold is active.
        if (b.checkout_hold_expires_at) {
          if (new Date(b.checkout_hold_expires_at).getTime() > holdNow) {
            slots.push({ start: b.starts_at, end: b.ends_at });
          }
          continue;
        }
        // Pay-later bookings reserve once moved to pending_payment after email confirm.
        slots.push({ start: b.starts_at, end: b.ends_at });
        continue;
      }

      if (b.status === 'confirmed' || b.status === 'cash_ok') {
        slots.push({ start: b.starts_at, end: b.ends_at });
      }
    }

    return slots;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  async getPublishedEvents(): Promise<Event[]> {
    return [...mockState.events.values()]
      .filter((e) => e.status === 'published')
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }

  async getEventBySlug(slug: string): Promise<Event | null> {
    for (const e of mockState.events.values()) {
      if (e.slug === slug) return e;
    }
    return null;
  }

  async getEventById(id: string): Promise<Event | null> {
    return mockState.events.get(id) ?? null;
  }

  async countEventActiveBookings(eventId: string, nowIso: string): Promise<number> {
    const nowMs = new Date(nowIso).getTime();
    let count = 0;

    for (const b of mockState.bookings.values()) {
      if (b.source !== 'event' || b.event_id !== eventId) continue;

      if (b.status === 'confirmed' || b.status === 'cash_ok') {
        count += 1;
        continue;
      }

      if (b.status === 'pending_payment') {
        if (!b.checkout_hold_expires_at || new Date(b.checkout_hold_expires_at).getTime() > nowMs) {
          count += 1;
        }
      }
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
    const payment: Payment = { ...data, id: crypto.randomUUID(), created_at: now(), updated_at: now() };
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
    for (const p of mockState.payments.values()) {
      if (p.provider_payment_id === sessionId) return p;
    }
    return null;
  }

  async updatePayment(id: string, updates: PaymentUpdate): Promise<Payment> {
    const existing = mockState.payments.get(id);
    if (!existing) throw new Error(`Payment ${id} not found`);
    const updated: Payment = { ...existing, ...updates, updated_at: now() };
    mockState.payments.set(id, updated);
    return updated;
  }

  // ── Contact form ─────────────────────────────────────────────────────────

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

  // ── PA organizer reads/writes ─────────────────────────────────────────────

  async getOrganizerBookings(filters: OrganizerBookingFilters): Promise<OrganizerBookingRow[]> {
    const rows: OrganizerBookingRow[] = [];

    for (const booking of mockState.bookings.values()) {
      const hydrated = this.hydrateBooking(booking);

      if (filters.source && hydrated.source !== filters.source) continue;
      if (filters.event_id && hydrated.event_id !== filters.event_id) continue;
      if (filters.client_id && hydrated.client_id !== filters.client_id) continue;
      if (filters.status && hydrated.status !== filters.status) continue;
      if (filters.date) {
        const day = hydrated.starts_at.slice(0, 10);
        if (day !== filters.date) continue;
      }

      const client = mockState.clients.get(hydrated.client_id);
      if (!client) continue;
      const event = hydrated.event_id ? mockState.events.get(hydrated.event_id) : null;

      rows.push({
        booking_id: hydrated.id,
        source: hydrated.source,
        status: hydrated.status,
        event_id: hydrated.event_id,
        event_title: event?.title ?? null,
        starts_at: hydrated.starts_at,
        ends_at: hydrated.ends_at,
        timezone: hydrated.timezone,
        attended: hydrated.attended,
        notes: hydrated.notes,
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

  // ── Scheduled job queries ────────────────────────────────────────────────

  async getExpiredBookingHolds(): Promise<Booking[]> {
    const n = Date.now();
    return [...mockState.bookings.values()]
      .filter((b) =>
        b.status === 'pending_payment' &&
        b.checkout_hold_expires_at !== null &&
        b.payment_due_at === null &&
        new Date(b.checkout_hold_expires_at).getTime() <= n,
      )
      .map((b) => this.hydrateBooking(b));
  }

  async getUnconfirmedBookingFollowupsDue(): Promise<Booking[]> {
    const n = Date.now();
    return [...mockState.bookings.values()]
      .filter((b) =>
        b.status === 'pending_email' &&
        b.followup_sent_at === null &&
        b.followup_scheduled_at !== null &&
        new Date(b.followup_scheduled_at).getTime() <= n,
      )
      .map((b) => this.hydrateBooking(b));
  }

  async getPaymentDueRemindersDue(): Promise<Booking[]> {
    const n = Date.now();
    return [...mockState.bookings.values()]
      .filter((b) =>
        b.status === 'pending_payment' &&
        b.payment_due_at !== null &&
        b.payment_due_reminder_sent_at === null &&
        b.payment_due_reminder_scheduled_at !== null &&
        new Date(b.payment_due_reminder_scheduled_at).getTime() <= n,
      )
      .map((b) => this.hydrateBooking(b));
  }

  async getPaymentDueCancellationsDue(): Promise<Booking[]> {
    const n = Date.now();
    return [...mockState.bookings.values()]
      .filter((b) =>
        b.status === 'pending_payment' &&
        b.payment_due_at !== null &&
        new Date(b.payment_due_at).getTime() <= n,
      )
      .map((b) => this.hydrateBooking(b));
  }

  async get24hBookingRemindersDue(): Promise<Booking[]> {
    const n = Date.now();
    return [...mockState.bookings.values()]
      .filter((b) =>
        (b.status === 'confirmed' || b.status === 'cash_ok') &&
        b.reminder_email_opt_in &&
        b.reminder_24h_sent_at === null &&
        b.reminder_24h_scheduled_at !== null &&
        new Date(b.reminder_24h_scheduled_at).getTime() <= n,
      )
      .map((b) => this.hydrateBooking(b));
  }

  // ── Observability ────────────────────────────────────────────────────────

  async logFailure(data: NewFailureLog): Promise<void> {
    const log: FailureLog = {
      id: crypto.randomUUID(),
      source: data.source,
      operation: data.operation,
      severity: data.severity ?? 'error',
      status: 'open',
      request_id: data.request_id ?? null,
      idempotency_key: data.idempotency_key ?? null,
      booking_id: data.booking_id ?? null,
      payment_id: data.payment_id ?? null,
      client_id: data.client_id ?? null,
      stripe_event_id: data.stripe_event_id ?? null,
      stripe_checkout_session_id: data.stripe_checkout_session_id ?? null,
      google_event_id: data.google_event_id ?? null,
      email_provider_message_id: data.email_provider_message_id ?? null,
      error_code: data.error_code ?? null,
      error_message: data.error_message,
      error_stack: data.error_stack ?? null,
      http_status: data.http_status ?? null,
      retryable: data.retryable ?? true,
      context: data.context ?? {},
      attempts: 0,
      next_retry_at: null,
      resolved_at: null,
      created_at: now(),
      updated_at: now(),
    };
    mockState.failureLogs.push(log);
  }

  async getRecentFailureLogs(limit: number): Promise<FailureLog[]> {
    return mockState.failureLogs.slice(-limit).reverse();
  }

  // ── Calendar sync retry queue ────────────────────────────────────────────

  async recordCalendarSyncFailure(input: {
    booking_id: string;
    operation: 'create' | 'update' | 'delete';
    error_message: string;
    request_id?: string | null;
    maxAttempts: number;
  }): Promise<CalendarSyncFailure> {
    const existing = [...mockState.failureLogs]
      .reverse()
      .find((log) =>
        log.source === 'calendar' &&
        log.operation === CALENDAR_SYNC_OPERATION &&
        log.booking_id === input.booking_id &&
        log.resolved_at === null &&
        log.retryable,
      ) ?? null;

    const attempts = (existing?.attempts ?? 0) + 1;
    const exhausted = attempts >= input.maxAttempts;
    const nextRetryAt = exhausted ? null : new Date(Date.now() + computeRetryDelayMs(attempts)).toISOString();
    const status = exhausted ? 'ignored' : 'retrying';

    if (existing) {
      existing.attempts = attempts;
      existing.next_retry_at = nextRetryAt;
      existing.status = status;
      existing.retryable = !exhausted;
      existing.error_message = input.error_message;
      existing.request_id = input.request_id ?? existing.request_id;
      existing.context = {
        ...(existing.context ?? {}),
        calendar_operation: input.operation,
        last_error: input.error_message,
      };
      existing.updated_at = now();
      return toCalendarSyncFailure(existing);
    }

    const created: FailureLog = {
      id: crypto.randomUUID(),
      source: 'calendar',
      operation: CALENDAR_SYNC_OPERATION,
      severity: exhausted ? 'critical' : 'error',
      status,
      request_id: input.request_id ?? null,
      idempotency_key: null,
      booking_id: input.booking_id,
      payment_id: null,
      client_id: null,
      stripe_event_id: null,
      stripe_checkout_session_id: null,
      google_event_id: null,
      email_provider_message_id: null,
      error_code: null,
      error_message: input.error_message,
      error_stack: null,
      http_status: null,
      retryable: !exhausted,
      context: {
        calendar_operation: input.operation,
        last_error: input.error_message,
      },
      attempts,
      next_retry_at: nextRetryAt,
      resolved_at: null,
      created_at: now(),
      updated_at: now(),
    };
    mockState.failureLogs.push(created);
    return toCalendarSyncFailure(created);
  }

  async getCalendarSyncFailuresDue(limit: number): Promise<CalendarSyncFailure[]> {
    const due = mockState.failureLogs
      .filter((log) =>
        log.source === 'calendar' &&
        log.operation === CALENDAR_SYNC_OPERATION &&
        log.retryable &&
        log.resolved_at === null &&
        log.next_retry_at !== null &&
        new Date(log.next_retry_at).getTime() <= Date.now(),
      )
      .sort((a, b) => {
        const aTime = a.next_retry_at ? new Date(a.next_retry_at).getTime() : Number.MAX_SAFE_INTEGER;
        const bTime = b.next_retry_at ? new Date(b.next_retry_at).getTime() : Number.MAX_SAFE_INTEGER;
        return aTime - bTime;
      })
      .slice(0, Math.max(1, limit));
    return due.map(toCalendarSyncFailure);
  }

  async resolveCalendarSyncFailure(
    bookingId: string,
    resolution: 'resolved' | 'ignored' = 'resolved',
    note?: string | null,
  ): Promise<void> {
    const active = [...mockState.failureLogs]
      .reverse()
      .find((log) =>
        log.source === 'calendar' &&
        log.operation === CALENDAR_SYNC_OPERATION &&
        log.booking_id === bookingId &&
        log.resolved_at === null,
      );
    if (!active) return;

    active.status = resolution;
    active.retryable = false;
    active.next_retry_at = null;
    active.resolved_at = now();
    if (note) {
      active.context = {
        ...(active.context ?? {}),
        resolution_note: note,
      };
    }
    active.updated_at = now();
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
    };
  }
}

function toCalendarSyncFailure(log: FailureLog): CalendarSyncFailure {
  const op = String(log.context?.['calendar_operation'] ?? 'update');
  const operation: 'create' | 'update' | 'delete' =
    op === 'create' || op === 'delete' ? op : 'update';
  const lastError = String(log.context?.['last_error'] ?? log.error_message ?? 'calendar sync failed');
  return {
    id: log.id,
    booking_id: log.booking_id ?? '',
    operation,
    attempts: log.attempts,
    next_retry_at: log.next_retry_at,
    last_error: lastError,
    resolved_at: log.resolved_at,
    status: log.status,
  };
}

function computeRetryDelayMs(attempt: number): number {
  const clamped = Math.max(1, Math.min(6, attempt));
  return Math.min(60 * 60 * 1000, (2 ** clamped) * 60 * 1000);
}
