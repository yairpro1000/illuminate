import type { Db } from '../../repo/supabase.js';
import type { OrganizerBookingFilters, IRepository } from './interface.js';
import type {
  Booking,
  BookingUpdate,
  CalendarSyncFailure,
  Client,
  ClientUpdate,
  ContactMessage,
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
  TimeSlot,
} from '../../types.js';

const CALENDAR_SYNC_OPERATION = 'calendar_sync';
const BOOKING_SELECT = `
  *,
  client:clients!bookings_client_id_fkey (
    first_name,
    last_name,
    email,
    phone
  ),
  event:events!bookings_event_id_fkey (
    id,
    title
  )
`;

type BookingRow = Omit<Booking, 'client_first_name' | 'client_last_name' | 'client_email' | 'client_phone' | 'event_title'> & {
  client?: {
    first_name: string;
    last_name: string | null;
    email: string;
    phone: string | null;
  } | null;
  event?: {
    id: string;
    title: string;
  } | null;
};

export class SupabaseRepository implements IRepository {
  constructor(private readonly db: Db) {}

  async createClient(data: NewClient): Promise<Client> {
    const payload = {
      ...data,
      email: normalizeEmail(data.email),
    };
    const row = await requireSingle<Client>(
      this.db.from('clients').insert(payload).select('*').single(),
      'Failed to create client',
    );
    return row;
  }

  async getClientById(id: string): Promise<Client | null> {
    return maybeSingle<Client>(
      this.db.from('clients').select('*').eq('id', id).limit(1).maybeSingle(),
      'Failed to load client',
    );
  }

  async getClientByEmail(email: string): Promise<Client | null> {
    return maybeSingle<Client>(
      this.db.from('clients').select('*').eq('email', normalizeEmail(email)).limit(1).maybeSingle(),
      'Failed to load client by email',
    );
  }

  async updateClient(id: string, updates: ClientUpdate): Promise<Client> {
    const payload = {
      ...updates,
      ...(updates.email ? { email: normalizeEmail(updates.email) } : {}),
      updated_at: nowIso(),
    };
    const row = await requireSingle<Client>(
      this.db.from('clients').update(payload).eq('id', id).select('*').single(),
      `Failed to update client ${id}`,
    );
    return row;
  }

  async createBooking(data: NewBooking): Promise<Booking> {
    const created = await requireSingle<{ id: string }>(
      this.db.from('bookings').insert(data).select('id').single(),
      'Failed to create booking',
    );
    return this.requireBookingById(created.id);
  }

  async getBookingById(id: string): Promise<Booking | null> {
    const row = await maybeSingle<BookingRow>(
      this.db.from('bookings').select(BOOKING_SELECT).eq('id', id).limit(1).maybeSingle(),
      'Failed to load booking',
    );
    return row ? toBooking(row) : null;
  }

  async getBookingByConfirmTokenHash(hash: string): Promise<Booking | null> {
    const row = await maybeSingle<BookingRow>(
      this.db.from('bookings').select(BOOKING_SELECT).eq('confirm_token_hash', hash).limit(1).maybeSingle(),
      'Failed to load booking by confirm token',
    );
    return row ? toBooking(row) : null;
  }

  async getBookingByManageTokenHash(hash: string): Promise<Booking | null> {
    const row = await maybeSingle<BookingRow>(
      this.db.from('bookings').select(BOOKING_SELECT).eq('manage_token_hash', hash).limit(1).maybeSingle(),
      'Failed to load booking by manage token',
    );
    return row ? toBooking(row) : null;
  }

  async updateBooking(id: string, updates: BookingUpdate): Promise<Booking> {
    await requireSingle<{ id: string }>(
      this.db.from('bookings').update({
        ...updates,
        updated_at: nowIso(),
      }).eq('id', id).select('id').single(),
      `Failed to update booking ${id}`,
    );
    return this.requireBookingById(id);
  }

  async getHeldSlots(from: string, to: string): Promise<TimeSlot[]> {
    const rows = await requireData<Array<Pick<Booking, 'starts_at' | 'ends_at' | 'status' | 'checkout_hold_expires_at' | 'payment_due_at' | 'confirm_expires_at'>>>(
      this.db
        .from('bookings')
        .select('starts_at, ends_at, status, checkout_hold_expires_at, payment_due_at, confirm_expires_at')
        .eq('source', 'session')
        .lte('starts_at', endOfDayIso(to))
        .gte('ends_at', startOfDayIso(from)),
      'Failed to load held slots',
    );

    const nowMs = Date.now();
    return rows
      .filter((row) => {
        if (row.status === 'confirmed' || row.status === 'cash_ok') return true;
        if (row.status === 'pending_payment') {
          if (!row.checkout_hold_expires_at) return true;
          return new Date(row.checkout_hold_expires_at).getTime() > nowMs;
        }
        if (row.status === 'pending_email') {
          if (!row.confirm_expires_at && !row.checkout_hold_expires_at) return false;
          const dl = row.checkout_hold_expires_at ?? row.confirm_expires_at!;
          return new Date(dl).getTime() > nowMs;
        }
        return false;
      })
      .map((row) => ({ start: row.starts_at, end: row.ends_at }));
  }

  async getPublishedEvents(): Promise<Event[]> {
    const rows = await requireData<Event[]>(
      this.db.from('events').select('*').eq('status', 'published').order('starts_at', { ascending: true }),
      'Failed to load published events',
    );
    return rows;
  }

  async getEventBySlug(slug: string): Promise<Event | null> {
    return maybeSingle<Event>(
      this.db.from('events').select('*').eq('slug', slug).limit(1).maybeSingle(),
      'Failed to load event by slug',
    );
  }

  async getEventById(id: string): Promise<Event | null> {
    return maybeSingle<Event>(
      this.db.from('events').select('*').eq('id', id).limit(1).maybeSingle(),
      'Failed to load event',
    );
  }

  async countEventActiveBookings(eventId: string, nowIsoValue: string): Promise<number> {
    const rows = await requireData<Array<Pick<Booking, 'status' | 'checkout_hold_expires_at'>>>(
      this.db.from('bookings').select('status, checkout_hold_expires_at').eq('source', 'event').eq('event_id', eventId),
      'Failed to count event bookings',
    );
    const nowMs = new Date(nowIsoValue).getTime();

    return rows.filter((row) => {
      if (row.status === 'confirmed' || row.status === 'cash_ok') return true;
      if (row.status !== 'pending_payment') return false;
      if (!row.checkout_hold_expires_at) return true;
      return new Date(row.checkout_hold_expires_at).getTime() > nowMs;
    }).length;
  }

  async createOrUpdateEventReminderSubscription(
    data: NewEventReminderSubscription,
  ): Promise<EventReminderSubscription> {
    const row = await requireSingle<EventReminderSubscription>(
      this.db.from('event_reminder_subscriptions').upsert({
        ...data,
        email: normalizeEmail(data.email),
        event_family: data.event_family.trim() || 'illuminate_evenings',
      }, {
        onConflict: 'email,event_family',
      }).select('*').single(),
      'Failed to upsert event reminder subscription',
    );
    return row;
  }

  async createEventLateAccessLink(data: NewEventLateAccessLink): Promise<EventLateAccessLink> {
    const row = await requireSingle<EventLateAccessLink>(
      this.db.from('event_late_access_links').insert(data).select('*').single(),
      'Failed to create event late-access link',
    );
    return row;
  }

  async revokeActiveEventLateAccessLinks(eventId: string): Promise<number> {
    const rows = await requireData<Array<{ id: string }>>(
      this.db
        .from('event_late_access_links')
        .update({ revoked_at: nowIso() })
        .eq('event_id', eventId)
        .is('revoked_at', null)
        .select('id'),
      'Failed to revoke event late-access links',
    );
    return rows.length;
  }

  async getEventLateAccessLinkByTokenHash(eventId: string, tokenHash: string): Promise<EventLateAccessLink | null> {
    return maybeSingle<EventLateAccessLink>(
      this.db
        .from('event_late_access_links')
        .select('*')
        .eq('event_id', eventId)
        .eq('token_hash', tokenHash)
        .limit(1)
        .maybeSingle(),
      'Failed to load event late-access link',
    );
  }

  async getActiveEventLateAccessLinkForEvent(eventId: string, nowIsoValue: string): Promise<EventLateAccessLink | null> {
    return maybeSingle<EventLateAccessLink>(
      this.db
        .from('event_late_access_links')
        .select('*')
        .eq('event_id', eventId)
        .is('revoked_at', null)
        .gt('expires_at', nowIsoValue)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'Failed to load active late-access link',
    );
  }

  async createPayment(data: NewPayment): Promise<Payment> {
    const row = await requireSingle<Payment>(
      this.db.from('payments').insert(data).select('*').single(),
      'Failed to create payment',
    );
    return row;
  }

  async getPaymentByBookingId(bookingId: string): Promise<Payment | null> {
    return maybeSingle<Payment>(
      this.db
        .from('payments')
        .select('*')
        .eq('booking_id', bookingId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'Failed to load payment by booking',
    );
  }

  async getPaymentByStripeSessionId(sessionId: string): Promise<Payment | null> {
    return maybeSingle<Payment>(
      this.db
        .from('payments')
        .select('*')
        .eq('provider_payment_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'Failed to load payment by provider session',
    );
  }

  async updatePayment(id: string, updates: PaymentUpdate): Promise<Payment> {
    const row = await requireSingle<Payment>(
      this.db.from('payments').update({
        ...updates,
        updated_at: nowIso(),
      }).eq('id', id).select('*').single(),
      `Failed to update payment ${id}`,
    );
    return row;
  }

  async createContactMessage(data: NewContactMessage): Promise<ContactMessage> {
    const row = await requireSingle<ContactMessage>(
      this.db.from('contact_messages').insert({
        ...data,
        email: normalizeEmail(data.email),
      }).select('*').single(),
      'Failed to create contact message',
    );
    return row;
  }

  async getOrganizerBookings(filters: OrganizerBookingFilters): Promise<OrganizerBookingRow[]> {
    let query: any = this.db
      .from('bookings')
      .select(BOOKING_SELECT)
      .order('starts_at', { ascending: true });

    if (filters.source) query = query.eq('source', filters.source);
    if (filters.event_id) query = query.eq('event_id', filters.event_id);
    if (filters.client_id) query = query.eq('client_id', filters.client_id);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.date) {
      query = query
        .gte('starts_at', startOfDayIso(filters.date))
        .lte('starts_at', endOfDayIso(filters.date));
    }

    const rows = await requireData<BookingRow[]>(query, 'Failed to load organizer bookings');
    return rows.map((row) => toOrganizerBookingRow(toBooking(row)));
  }

  async getExpiredBookingHolds(): Promise<Booking[]> {
    // Use new lifecycle fields primarily; also include legacy fallback
    return this.getBookingList((query) =>
      query
        .or(
          'and(booking_status.eq.pending,not.hold_expires_at.is.null,hold_expires_at.lte.' + nowIso() + '),' +
          'and(status.eq.pending_payment,not.checkout_hold_expires_at.is.null,payment_due_at.is.null,checkout_hold_expires_at.lte.' + nowIso() + ')' +
          ''
        )
    );
  }

  async getUnconfirmedBookingFollowupsDue(): Promise<Booking[]> {
    return this.getBookingList((query) =>
      query
        .eq('status', 'pending_email')
        .is('followup_sent_at', null)
        .not('followup_scheduled_at', 'is', null)
        .lte('followup_scheduled_at', nowIso()),
    );
  }

  async getPaymentDueRemindersDue(): Promise<Booking[]> {
    return this.getBookingList((query) =>
      query
        .or(
          'and(booking_status.eq.confirmed,payment_mode.eq.pay_later,payment_status_v2.eq.pending,not.payment_due_reminder_scheduled_at.is.null,payment_due_reminder_scheduled_at.lte.' + nowIso() + ',payment_due_reminder_sent_at.is.null),' +
          'and(status.eq.pending_payment,not.payment_due_at.is.null,not.payment_due_reminder_scheduled_at.is.null,payment_due_reminder_scheduled_at.lte.' + nowIso() + ',payment_due_reminder_sent_at.is.null)'
        )
    );
  }

  async getPaymentDueCancellationsDue(): Promise<Booking[]> {
    return this.getBookingList((query) =>
      query
        .or(
          'and(booking_status.eq.confirmed,payment_mode.eq.pay_later,payment_status_v2.eq.pending,not.payment_due_at.is.null,payment_due_at.lte.' + nowIso() + '),' +
          'and(status.eq.pending_payment,not.payment_due_at.is.null,payment_due_at.lte.' + nowIso() + ')'
        )
    );
  }

  async get24hBookingRemindersDue(): Promise<Booking[]> {
    return this.getBookingList((query) =>
      query
        .or(
          'and(booking_status.eq.confirmed,reminder_email_opt_in.eq.true,reminder_24h_sent_at.is.null,not.reminder_24h_scheduled_at.is.null,reminder_24h_scheduled_at.lte.' + nowIso() + '),' +
          'and(status.in.(confirmed,cash_ok),reminder_email_opt_in.eq.true,reminder_24h_sent_at.is.null,not.reminder_24h_scheduled_at.is.null,reminder_24h_scheduled_at.lte.' + nowIso() + ')'
        )
    );
  }

  async logFailure(data: NewFailureLog): Promise<void> {
    await requireData(
      this.db.from('failure_logs').insert({
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
      }).select('id'),
      'Failed to persist failure log',
    );
  }

  async getRecentFailureLogs(limit: number): Promise<FailureLog[]> {
    const rows = await requireData<FailureLog[]>(
      this.db
        .from('failure_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(Math.max(1, limit)),
      'Failed to load recent failure logs',
    );
    return rows;
  }

  async createBookingEvent(data: {
    booking_id: string;
    event_type: string;
    source: 'ui' | 'webhook' | 'cron' | 'admin' | 'system';
    payload?: Record<string, unknown>;
  }): Promise<void> {
    await requireData(
      this.db
        .from('booking_events')
        .insert({
          booking_id: data.booking_id,
          event_type: data.event_type,
          source: data.source,
          payload: data.payload ?? {},
        })
        .select('id'),
      'Failed to persist booking event',
    );
  }

  async enqueueSideEffect(data: { booking_id: string; effect_type: string; payload?: Record<string, unknown> }): Promise<{ id: string } | null> {
    const exists = await this.db.from('booking_side_effects').select('id').limit(1).maybeSingle();
    if (exists.error && exists.error.code === 'PGRST116') return null; // table missing — feature disabled
    const row = await requireSingle<{ id: string }>(
      this.db
        .from('booking_side_effects')
        .insert({
          booking_id: data.booking_id,
          effect_type: data.effect_type,
          status: 'pending',
          payload: data.payload ?? {},
        })
        .select('id')
        .single(),
      'Failed to enqueue side effect',
    );
    return row;
  }

  async markSideEffect(id: string, status: 'pending' | 'processing' | 'done' | 'failed', error_message?: string | null): Promise<void> {
    const exists = await this.db.from('booking_side_effects').select('id').eq('id', id).maybeSingle();
    if (exists.error && exists.error.code === 'PGRST116') return; // table missing
    await requireData(
      this.db
        .from('booking_side_effects')
        .update({ status, error_message: error_message ?? null, updated_at: nowIso() })
        .eq('id', id)
        .select('id'),
      'Failed to update side-effect status',
    );
  }

  async getPendingSideEffects(limit: number): Promise<Array<{ id: string; booking_id: string; effect_type: string; payload: Record<string, unknown> | null }>> {
    const exists = await this.db.from('booking_side_effects').select('id').limit(1).maybeSingle();
    if (exists.error && exists.error.code === 'PGRST116') return [];
    const rows = await requireData<Array<{ id: string; booking_id: string; effect_type: string; payload: any }>>(
      this.db
        .from('booking_side_effects')
        .select('id, booking_id, effect_type, payload')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(Math.max(1, limit)),
      'Failed to load pending side effects',
    );
    return rows.map(r => ({ id: r.id, booking_id: r.booking_id, effect_type: r.effect_type, payload: r.payload ?? null }));
  }

  async recordCalendarSyncFailure(input: {
    booking_id: string;
    operation: 'create' | 'update' | 'delete';
    error_message: string;
    request_id?: string | null;
    maxAttempts: number;
  }): Promise<CalendarSyncFailure> {
    const existing = await maybeSingle<FailureLog>(
      this.db
        .from('failure_logs')
        .select('*')
        .eq('source', 'calendar')
        .eq('operation', CALENDAR_SYNC_OPERATION)
        .eq('booking_id', input.booking_id)
        .is('resolved_at', null)
        .limit(1)
        .maybeSingle(),
      'Failed to load active calendar sync failure',
    );

    const attempts = (existing?.attempts ?? 0) + 1;
    const exhausted = attempts >= input.maxAttempts;
    const nextRetryAt = exhausted ? null : new Date(Date.now() + computeRetryDelayMs(attempts)).toISOString();
    const status = exhausted ? 'ignored' : 'retrying';

    if (existing) {
      const updated = await requireSingle<FailureLog>(
        this.db
          .from('failure_logs')
          .update({
            attempts,
            next_retry_at: nextRetryAt,
            status,
            retryable: !exhausted,
            error_message: input.error_message,
            request_id: input.request_id ?? existing.request_id,
            severity: exhausted ? 'critical' : 'error',
            context: {
              ...(existing.context ?? {}),
              calendar_operation: input.operation,
              last_error: input.error_message,
            },
            updated_at: nowIso(),
          })
          .eq('id', existing.id)
          .select('*')
          .single(),
        `Failed to update calendar sync failure for booking ${input.booking_id}`,
      );
      return toCalendarSyncFailure(updated);
    }

    const created = await requireSingle<FailureLog>(
      this.db
        .from('failure_logs')
        .insert({
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
        })
        .select('*')
        .single(),
      `Failed to create calendar sync failure for booking ${input.booking_id}`,
    );
    return toCalendarSyncFailure(created);
  }

  async getCalendarSyncFailuresDue(limit: number): Promise<CalendarSyncFailure[]> {
    const rows = await requireData<FailureLog[]>(
      this.db
        .from('failure_logs')
        .select('*')
        .eq('source', 'calendar')
        .eq('operation', CALENDAR_SYNC_OPERATION)
        .eq('retryable', true)
        .is('resolved_at', null)
        .not('next_retry_at', 'is', null)
        .lte('next_retry_at', nowIso())
        .order('next_retry_at', { ascending: true })
        .limit(Math.max(1, limit)),
      'Failed to load due calendar sync failures',
    );
    return rows.map(toCalendarSyncFailure);
  }

  async resolveCalendarSyncFailure(
    bookingId: string,
    resolution: 'resolved' | 'ignored' = 'resolved',
    note?: string | null,
  ): Promise<void> {
    const active = await maybeSingle<FailureLog>(
      this.db
        .from('failure_logs')
        .select('*')
        .eq('source', 'calendar')
        .eq('operation', CALENDAR_SYNC_OPERATION)
        .eq('booking_id', bookingId)
        .is('resolved_at', null)
        .limit(1)
        .maybeSingle(),
      'Failed to load active calendar sync failure for resolution',
    );

    if (!active) return;

    await requireData(
      this.db
        .from('failure_logs')
        .update({
          status: resolution,
          retryable: false,
          next_retry_at: null,
          resolved_at: nowIso(),
          updated_at: nowIso(),
          context: note
            ? {
                ...(active.context ?? {}),
                resolution_note: note,
              }
            : active.context,
        })
        .eq('id', active.id)
        .select('id'),
      `Failed to resolve calendar sync failure for booking ${bookingId}`,
    );
  }

  private async getBookingList(
    build: (query: any) => any,
  ): Promise<Booking[]> {
    let query: any = this.db.from('bookings').select(BOOKING_SELECT).order('starts_at', { ascending: true });
    query = build(query);
    const rows = await requireData<BookingRow[]>(query, 'Failed to load booking list');
    return rows.map(toBooking);
  }

  private async requireBookingById(id: string): Promise<Booking> {
    const booking = await this.getBookingById(id);
    if (!booking) throw new Error(`Booking ${id} not found after write`);
    return booking;
  }
}

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    client_id: row.client_id,
    source: row.source,
    status: row.status,
    booking_status: (row as any).booking_status ?? null,
    payment_mode: (row as any).payment_mode ?? null,
    payment_status_v2: (row as any).payment_status_v2 ?? null,
    email_status: (row as any).email_status ?? null,
    calendar_status: (row as any).calendar_status ?? null,
    slot_status: (row as any).slot_status ?? null,
    event_id: row.event_id,
    session_type: row.session_type,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    timezone: row.timezone,
    address_line: row.address_line,
    maps_url: row.maps_url,
    attended: row.attended,
    notes: row.notes,
    confirm_token_hash: row.confirm_token_hash,
    confirm_expires_at: row.confirm_expires_at,
    manage_token_hash: row.manage_token_hash,
    checkout_session_id: row.checkout_session_id,
    checkout_hold_expires_at: row.checkout_hold_expires_at,
    hold_expires_at: (row as any).hold_expires_at ?? null,
    payment_due_at: row.payment_due_at,
    payment_due_at_v2: (row as any).payment_due_at_v2 ?? null,
    payment_due_reminder_scheduled_at: row.payment_due_reminder_scheduled_at,
    payment_due_reminder_sent_at: row.payment_due_reminder_sent_at,
    followup_scheduled_at: row.followup_scheduled_at,
    followup_sent_at: row.followup_sent_at,
    reminder_email_opt_in: row.reminder_email_opt_in,
    reminder_whatsapp_opt_in: row.reminder_whatsapp_opt_in,
    reminder_24h_scheduled_at: row.reminder_24h_scheduled_at,
    reminder_24h_sent_at: row.reminder_24h_sent_at,
    google_event_id: row.google_event_id,
    email_confirmed_at: (row as any).email_confirmed_at ?? null,
    confirmed_at: (row as any).confirmed_at ?? null,
    cancelled_at: (row as any).cancelled_at ?? null,
    expired_at: (row as any).expired_at ?? null,
    reminder_36h_sent_at: (row as any).reminder_36h_sent_at ?? null,
    last_payment_link_sent_at: (row as any).last_payment_link_sent_at ?? null,
    expired_reason: (row as any).expired_reason ?? null,
    cancel_reason: (row as any).cancel_reason ?? null,
    metadata: (row as any).metadata ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    client_first_name: row.client?.first_name,
    client_last_name: row.client?.last_name ?? null,
    client_email: row.client?.email,
    client_phone: row.client?.phone ?? null,
    event_title: row.event?.title ?? null,
  };
}

function toOrganizerBookingRow(booking: Booking): OrganizerBookingRow {
  if (!booking.client_first_name || !booking.client_email) {
    throw new Error(`Booking ${booking.id} is missing organizer join data`);
  }

  return {
    booking_id: booking.id,
    source: booking.source,
    status: booking.status,
    event_id: booking.event_id,
    event_title: booking.event_title ?? null,
    starts_at: booking.starts_at,
    ends_at: booking.ends_at,
    timezone: booking.timezone,
    attended: booking.attended,
    notes: booking.notes,
    client_id: booking.client_id,
    client_first_name: booking.client_first_name,
    client_last_name: booking.client_last_name ?? null,
    client_email: booking.client_email,
    client_phone: booking.client_phone ?? null,
  };
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function startOfDayIso(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function endOfDayIso(date: string): string {
  return `${date}T23:59:59.999Z`;
}

function computeRetryDelayMs(attempt: number): number {
  const clamped = Math.max(1, Math.min(6, attempt));
  return Math.min(60 * 60 * 1000, (2 ** clamped) * 60 * 1000);
}

async function requireSingle<T>(
  promise: PromiseLike<{ data: T | null; error: { message: string } | null }>,
  message: string,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${message}: ${error.message}`);
  if (data === null) throw new Error(message);
  return data;
}

async function maybeSingle<T>(
  promise: PromiseLike<{ data: T | null; error: { code?: string; message: string } | null }>,
  message: string,
): Promise<T | null> {
  const { data, error } = await promise;
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`${message}: ${error.message}`);
  }
  return data;
}

async function requireData<T>(
  promise: PromiseLike<{ data: T | null; error: { message: string } | null }>,
  message: string,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${message}: ${error.message}`);
  if (data === null) throw new Error(message);
  return data;
}
