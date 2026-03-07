import { mockState } from '../mock-state.js';
import type { IRepository } from './interface.js';
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

const now = () => new Date().toISOString();

export class MockRepository implements IRepository {

  // ── Bookings ──────────────────────────────────────────────────────────────

  async createBooking(data: NewBooking): Promise<Booking> {
    const booking: Booking = { ...data, id: crypto.randomUUID(), created_at: now(), updated_at: now() };
    mockState.bookings.set(booking.id, booking);
    return booking;
  }

  async getBookingById(id: string): Promise<Booking | null> {
    return mockState.bookings.get(id) ?? null;
  }

  async getBookingByConfirmTokenHash(hash: string): Promise<Booking | null> {
    for (const b of mockState.bookings.values()) {
      if (b.confirm_token_hash === hash) return b;
    }
    return null;
  }

  async getBookingByManageTokenHash(hash: string): Promise<Booking | null> {
    for (const b of mockState.bookings.values()) {
      if (b.manage_token_hash === hash) return b;
    }
    return null;
  }

  async updateBooking(id: string, updates: BookingUpdate): Promise<Booking> {
    const existing = mockState.bookings.get(id);
    if (!existing) throw new Error(`Booking ${id} not found`);
    const updated: Booking = { ...existing, ...updates, updated_at: now() };
    mockState.bookings.set(id, updated);
    return updated;
  }

  async getHeldSlots(from: string, to: string): Promise<TimeSlot[]> {
    const fromMs = new Date(from).getTime();
    const toMs   = new Date(to).getTime();
    const slots: TimeSlot[] = [];
    const holdNow = Date.now();

    for (const b of mockState.bookings.values()) {
      const start = new Date(b.starts_at).getTime();
      const end   = new Date(b.ends_at).getTime();
      if (end < fromMs || start > toMs) continue;

      // Pay-now hold: only counts while checkout window is active
      if (b.status === 'pending_payment' && b.payment_due_at === null) {
        if (b.checkout_hold_expires_at && new Date(b.checkout_hold_expires_at).getTime() > holdNow) {
          slots.push({ start: b.starts_at, end: b.ends_at });
        }
        continue;
      }
      // Pay-later pending/confirmed/cash_ok: slot is committed
      if (['pending_payment', 'confirmed', 'cash_ok'].includes(b.status)) {
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

  // ── Event registrations ───────────────────────────────────────────────────

  async createRegistration(
    data: NewEventRegistration,
    additionalAttendees: string[],
  ): Promise<EventRegistration> {
    const reg: EventRegistration = {
      ...data,
      id: crypto.randomUUID(),
      created_at: now(),
      updated_at: now(),
    };
    mockState.registrations.set(reg.id, reg);

    additionalAttendees.forEach((name, i) => {
      const attendee: EventAttendee = {
        id: crypto.randomUUID(),
        registration_id: reg.id,
        full_name: name,
        sort_order: i + 1,
      };
      mockState.attendees.set(attendee.id, attendee);
    });

    return reg;
  }

  async getRegistrationById(id: string): Promise<EventRegistration | null> {
    return mockState.registrations.get(id) ?? null;
  }

  async getRegistrationByConfirmTokenHash(hash: string): Promise<EventRegistration | null> {
    for (const r of mockState.registrations.values()) {
      if (r.confirm_token_hash === hash) return r;
    }
    return null;
  }

  async getRegistrationByManageTokenHash(hash: string): Promise<EventRegistration | null> {
    for (const r of mockState.registrations.values()) {
      if (r.manage_token_hash === hash) return r;
    }
    return null;
  }

  async getAttendeesByRegistrationId(registrationId: string): Promise<EventAttendee[]> {
    return [...mockState.attendees.values()]
      .filter((a) => a.registration_id === registrationId)
      .sort((a, b) => a.sort_order - b.sort_order);
  }

  async updateRegistration(id: string, updates: RegistrationUpdate): Promise<EventRegistration> {
    const existing = mockState.registrations.get(id);
    if (!existing) throw new Error(`Registration ${id} not found`);
    const updated: EventRegistration = { ...existing, ...updates, updated_at: now() };
    mockState.registrations.set(id, updated);
    return updated;
  }

  async countConfirmedRegistrations(eventId: string): Promise<number> {
    let count = 0;
    for (const r of mockState.registrations.values()) {
      if (r.event_id === eventId && r.status === 'confirmed') count += r.attendee_count;
    }
    return count;
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  async createPayment(data: NewPayment): Promise<Payment> {
    const payment: Payment = { ...data, id: crypto.randomUUID(), created_at: now(), updated_at: now() };
    mockState.payments.set(payment.id, payment);
    return payment;
  }

  async getPaymentByStripeSessionId(sessionId: string): Promise<Payment | null> {
    for (const p of mockState.payments.values()) {
      if (p.stripe_checkout_session_id === sessionId) return p;
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

  // ── Scheduled job queries ─────────────────────────────────────────────────

  async getExpiredBookingHolds(): Promise<Booking[]> {
    const n = Date.now();
    return [...mockState.bookings.values()].filter(
      (b) =>
        b.status === 'pending_payment' &&
        b.payment_due_at === null && // Pay-now only
        b.checkout_hold_expires_at !== null &&
        new Date(b.checkout_hold_expires_at).getTime() <= n,
    );
  }

  async getExpiredRegistrationHolds(): Promise<EventRegistration[]> {
    const n = Date.now();
    return [...mockState.registrations.values()].filter(
      (r) =>
        r.status === 'pending_payment' &&
        r.checkout_hold_expires_at !== null &&
        new Date(r.checkout_hold_expires_at).getTime() <= n,
    );
  }

  async getUnconfirmedBookingFollowupsDue(): Promise<Booking[]> {
    const n = Date.now();
    return [...mockState.bookings.values()].filter(
      (b) =>
        b.status === 'pending_email' &&
        b.followup_sent_at === null &&
        b.followup_scheduled_at !== null &&
        new Date(b.followup_scheduled_at).getTime() <= n,
    );
  }

  async getUnconfirmedRegistrationFollowupsDue(): Promise<EventRegistration[]> {
    const n = Date.now();
    return [...mockState.registrations.values()].filter(
      (r) =>
        r.status === 'pending_email' &&
        r.followup_sent_at === null &&
        r.followup_scheduled_at !== null &&
        new Date(r.followup_scheduled_at).getTime() <= n,
    );
  }

  async getPaymentDueRemindersDue(): Promise<Booking[]> {
    const n = Date.now();
    return [...mockState.bookings.values()].filter(
      (b) =>
        b.status === 'pending_payment' &&
        b.payment_due_at !== null && // Pay-later
        b.payment_due_reminder_sent_at === null &&
        b.payment_due_reminder_scheduled_at !== null &&
        new Date(b.payment_due_reminder_scheduled_at).getTime() <= n,
    );
  }

  async getPaymentDueCancellationsDue(): Promise<Booking[]> {
    const n = Date.now();
    return [...mockState.bookings.values()].filter(
      (b) =>
        b.status === 'pending_payment' &&
        b.payment_due_at !== null &&
        new Date(b.payment_due_at).getTime() <= n,
      // cash_ok is excluded because it won't have status='pending_payment'
    );
  }

  async get24hBookingRemindersDue(): Promise<Booking[]> {
    const n = Date.now();
    return [...mockState.bookings.values()].filter(
      (b) =>
        b.status === 'confirmed' &&
        b.reminder_email_opt_in &&
        b.reminder_24h_sent_at === null &&
        b.reminder_24h_scheduled_at !== null &&
        new Date(b.reminder_24h_scheduled_at).getTime() <= n,
    );
  }

  async get24hRegistrationRemindersDue(): Promise<EventRegistration[]> {
    const n = Date.now();
    return [...mockState.registrations.values()].filter(
      (r) =>
        r.status === 'confirmed' &&
        r.reminder_email_opt_in &&
        r.reminder_24h_sent_at === null &&
        r.reminder_24h_scheduled_at !== null &&
        new Date(r.reminder_24h_scheduled_at).getTime() <= n,
    );
  }

  // ── Observability ─────────────────────────────────────────────────────────

  async logFailure(data: NewFailureLog): Promise<void> {
    const log: FailureLog = {
      id: crypto.randomUUID(),
      source: data.source,
      operation: data.operation,
      severity: data.severity ?? 'error',
      status: 'open',
      request_id: data.request_id ?? null,
      idempotency_key: null,
      job_run_id: data.job_run_id ?? null,
      booking_id: data.booking_id ?? null,
      event_id: data.event_id ?? null,
      event_registration_id: data.event_registration_id ?? null,
      payment_id: data.payment_id ?? null,
      stripe_event_id: data.stripe_event_id ?? null,
      stripe_checkout_session_id: data.stripe_checkout_session_id ?? null,
      google_event_id: null,
      email_provider_message_id: null,
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

  async createJobRun(data: NewJobRun): Promise<JobRun> {
    const run: JobRun = {
      id: crypto.randomUUID(),
      job_name: data.job_name,
      status: 'running',
      started_at: now(),
      finished_at: null,
      items_found: 0,
      items_processed: 0,
      items_succeeded: 0,
      items_failed: 0,
      trigger_source: data.trigger_source ?? 'scheduler',
      request_id: data.request_id ?? null,
      error_summary: null,
      created_at: now(),
    };
    mockState.jobRuns.set(run.id, run);
    return run;
  }

  async updateJobRun(id: string, updates: JobRunUpdate): Promise<void> {
    const existing = mockState.jobRuns.get(id);
    if (!existing) return;
    mockState.jobRuns.set(id, { ...existing, ...updates });
  }
}
