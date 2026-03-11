import type { Db } from '../../repo/supabase.js';
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
  TimeSlot,
  SessionTypeRecord,
  NewSessionType,
  SessionTypeUpdate,
} from '../../types.js';

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
  ),
  session_type:session_types!bookings_session_type_id_fkey (
    id,
    title
  )
`;

type BookingRow = Omit<
  Booking,
  | 'client_first_name'
  | 'client_last_name'
  | 'client_email'
  | 'client_phone'
  | 'event_title'
  | 'session_type_title'
> & {
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
  session_type?: {
    id: string;
    title: string;
  } | null;
};

type PendingSideEffectRow = BookingSideEffect & {
  booking_event: {
    booking_id: string;
  } | null;
};

export class SupabaseRepository implements IRepository {
  constructor(private readonly db: Db) {}

  // ── Clients ───────────────────────────────────────────────────────────────

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

  // ── Bookings ──────────────────────────────────────────────────────────────

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
    const event = await maybeSingle<{ booking_id: string }>(
      this.db
        .from('booking_events')
        .select('booking_id')
        .eq('payload->>confirm_token_hash', hash)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'Failed to load booking event by confirm token hash',
    );

    if (!event) return null;
    return this.getBookingById(event.booking_id);
  }

  async updateBooking(id: string, updates: BookingUpdate): Promise<Booking> {
    await requireSingle<{ id: string }>(
      this.db
        .from('bookings')
        .update({ ...updates, updated_at: nowIso() })
        .eq('id', id)
        .select('id')
        .single(),
      `Failed to update booking ${id}`,
    );
    return this.requireBookingById(id);
  }

  async getHeldSlots(from: string, to: string): Promise<TimeSlot[]> {
    const rows = await requireData<Array<Pick<Booking, 'starts_at' | 'ends_at'>>>(
      this.db
        .from('bookings')
        .select('starts_at, ends_at')
        .is('event_id', null)
        .in('current_status', ['PENDING_CONFIRMATION', 'SLOT_CONFIRMED', 'PAID'])
        .lte('starts_at', endOfDayIso(to))
        .gte('ends_at', startOfDayIso(from)),
      'Failed to load held slots',
    );

    return rows.map((row) => ({ start: row.starts_at, end: row.ends_at }));
  }

  // ── Booking events ────────────────────────────────────────────────────────

  async createBookingEvent(data: {
    booking_id: string;
    event_type: BookingEventRecord['event_type'];
    source: BookingEventRecord['source'];
    payload?: Record<string, unknown>;
  }): Promise<BookingEventRecord> {
    const row = await requireSingle<BookingEventRecord>(
      this.db
        .from('booking_events')
        .insert({
          booking_id: data.booking_id,
          event_type: data.event_type,
          source: data.source,
          payload: data.payload ?? {},
        })
        .select('*')
        .single(),
      'Failed to persist booking event',
    );
    return row;
  }

  async listBookingEvents(bookingId: string): Promise<BookingEventRecord[]> {
    const rows = await requireData<BookingEventRecord[]>(
      this.db
        .from('booking_events')
        .select('*')
        .eq('booking_id', bookingId)
        .order('created_at', { ascending: true }),
      'Failed to load booking events',
    );
    return rows;
  }

  async getBookingEventById(eventId: string): Promise<BookingEventRecord | null> {
    return maybeSingle<BookingEventRecord>(
      this.db.from('booking_events').select('*').eq('id', eventId).limit(1).maybeSingle(),
      'Failed to load booking event',
    );
  }

  async getLatestBookingEvent(bookingId: string): Promise<BookingEventRecord | null> {
    return maybeSingle<BookingEventRecord>(
      this.db
        .from('booking_events')
        .select('*')
        .eq('booking_id', bookingId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'Failed to load latest booking event',
    );
  }

  // ── Booking side effects ─────────────────────────────────────────────────

  async createBookingSideEffects(effects: NewBookingSideEffect[]): Promise<BookingSideEffect[]> {
    if (effects.length === 0) return [];

    const rows = await requireData<BookingSideEffect[]>(
      this.db.from('booking_side_effects').insert(effects).select('*'),
      'Failed to create booking side effects',
    );
    return rows;
  }

  async getBookingSideEffectById(id: string): Promise<BookingSideEffect | null> {
    return maybeSingle<BookingSideEffect>(
      this.db.from('booking_side_effects').select('*').eq('id', id).limit(1).maybeSingle(),
      'Failed to load booking side effect',
    );
  }

  async getPendingBookingSideEffects(
    limit: number,
    _nowIso: string,
  ): Promise<Array<BookingSideEffect & { booking_id: string }>> {
    const rows = await requireData<PendingSideEffectRow[]>(
      this.db
        .from('booking_side_effects')
        .select(`
          *,
          booking_event:booking_events!booking_side_effects_booking_event_id_fkey (
            booking_id
          )
        `)
        .in('status', ['pending', 'failed'])
        .order('created_at', { ascending: true })
        .limit(Math.max(1, limit)),
      'Failed to load pending booking side effects',
    );

    return rows
      .filter((row) => row.booking_event?.booking_id)
      .map((row) => ({
        ...row,
        booking_id: row.booking_event!.booking_id,
      }));
  }

  async updateBookingSideEffect(
    id: string,
    updates: Partial<Pick<BookingSideEffect, 'status' | 'updated_at'>>,
  ): Promise<BookingSideEffect> {
    const row = await requireSingle<BookingSideEffect>(
      this.db
        .from('booking_side_effects')
        .update({
          ...updates,
          updated_at: updates.updated_at ?? nowIso(),
        })
        .eq('id', id)
        .select('*')
        .single(),
      `Failed to update booking side effect ${id}`,
    );
    return row;
  }

  async markStaleProcessingSideEffectsAsPending(nowIsoValue: string): Promise<number> {
    const threshold = new Date(new Date(nowIsoValue).getTime() - SIDE_EFFECT_PROCESSING_TIMEOUT_MINUTES * 60_000).toISOString();

    const rows = await requireData<Array<{ id: string }>>(
      this.db
        .from('booking_side_effects')
        .update({ status: 'pending', updated_at: nowIsoValue })
        .eq('status', 'processing')
        .lte('updated_at', threshold)
        .select('id'),
      'Failed to reset stale processing side effects',
    );

    return rows.length;
  }

  // ── Booking side effect attempts ──────────────────────────────────────────

  async createBookingSideEffectAttempt(data: NewBookingSideEffectAttempt): Promise<BookingSideEffectAttempt> {
    const row = await requireSingle<BookingSideEffectAttempt>(
      this.db.from('booking_side_effect_attempts').insert(data).select('*').single(),
      'Failed to create booking side effect attempt',
    );
    return row;
  }

  async listBookingSideEffectAttempts(sideEffectId: string): Promise<BookingSideEffectAttempt[]> {
    const rows = await requireData<BookingSideEffectAttempt[]>(
      this.db
        .from('booking_side_effect_attempts')
        .select('*')
        .eq('booking_side_effect_id', sideEffectId)
        .order('attempt_num', { ascending: true }),
      'Failed to load booking side effect attempts',
    );
    return rows;
  }

  async getLastBookingSideEffectAttempt(sideEffectId: string): Promise<BookingSideEffectAttempt | null> {
    return maybeSingle<BookingSideEffectAttempt>(
      this.db
        .from('booking_side_effect_attempts')
        .select('*')
        .eq('booking_side_effect_id', sideEffectId)
        .order('attempt_num', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'Failed to load latest booking side effect attempt',
    );
  }

  // ── Events ────────────────────────────────────────────────────────────────

  async getPublishedEvents(): Promise<Event[]> {
    const rows = await requireData<Event[]>(
      this.db.from('events').select('*').eq('status', 'published').order('starts_at', { ascending: true }),
      'Failed to load published events',
    );
    return rows;
  }

  async getAllEvents(): Promise<Event[]> {
    return requireData<Event[]>(
      this.db.from('events').select('*').order('starts_at', { ascending: false }),
      'Failed to load all events',
    );
  }

  async updateEvent(id: string, updates: import('../../types.js').EventUpdate): Promise<Event> {
    return requireSingle<Event>(
      this.db.from('events').update(updates).eq('id', id).select().single(),
      'Failed to update event',
    );
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

  async countEventActiveBookings(eventId: string, _nowIso: string): Promise<number> {
    const rows = await requireData<Array<Pick<Booking, 'current_status'>>>(
      this.db
        .from('bookings')
        .select('current_status')
        .eq('event_id', eventId)
        .not('current_status', 'in', '(EXPIRED,CANCELED,COMPLETED,NO_SHOW,REFUNDED)'),
      'Failed to count event bookings',
    );

    return rows.length;
  }

  // ── Event reminder subscriptions ──────────────────────────────────────────

  async createOrUpdateEventReminderSubscription(
    data: NewEventReminderSubscription,
  ): Promise<EventReminderSubscription> {
    const row = await requireSingle<EventReminderSubscription>(
      this.db
        .from('event_reminder_subscriptions')
        .upsert(
          {
            ...data,
            email: normalizeEmail(data.email),
            event_family: data.event_family.trim() || 'illuminate_evenings',
          },
          {
            onConflict: 'email,event_family',
          },
        )
        .select('*')
        .single(),
      'Failed to upsert event reminder subscription',
    );
    return row;
  }

  // ── Event late-access links ───────────────────────────────────────────────

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

  // ── Payments ──────────────────────────────────────────────────────────────

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
      this.db
        .from('payments')
        .update({
          ...updates,
          updated_at: nowIso(),
        })
        .eq('id', id)
        .select('*')
        .single(),
      `Failed to update payment ${id}`,
    );
    return row;
  }

  // ── Contact form ──────────────────────────────────────────────────────────

  async createContactMessage(data: NewContactMessage): Promise<ContactMessage> {
    const row = await requireSingle<ContactMessage>(
      this.db
        .from('contact_messages')
        .insert(data)
        .select('*')
        .single(),
      'Failed to create contact message',
    );
    return row;
  }

  // ── Organizer reads ───────────────────────────────────────────────────────

  async getOrganizerBookings(filters: OrganizerBookingFilters): Promise<OrganizerBookingRow[]> {
    let query: any = this.db.from('bookings').select(BOOKING_SELECT).order('starts_at', { ascending: true });

    if (filters.event_id) query = query.eq('event_id', filters.event_id);
    if (filters.client_id) query = query.eq('client_id', filters.client_id);
    if (filters.current_status) query = query.eq('current_status', filters.current_status);
    if (filters.booking_kind === 'event') query = query.not('event_id', 'is', null);
    if (filters.booking_kind === 'session') query = query.is('event_id', null);
    if (filters.date) {
      query = query
        .gte('starts_at', startOfDayIso(filters.date))
        .lte('starts_at', endOfDayIso(filters.date));
    }

    const rows = await requireData<BookingRow[]>(query, 'Failed to load organizer bookings');

    return rows.map((row) => {
      const booking = toBooking(row);
      if (!booking.client_first_name || !booking.client_email) {
        throw new Error(`Booking ${booking.id} is missing organizer join data`);
      }

      return {
        booking_id: booking.id,
        current_status: booking.current_status,
        event_id: booking.event_id,
        event_title: booking.event_title ?? null,
        session_type_id: booking.session_type_id,
        session_type_title: booking.session_type_title ?? null,
        starts_at: booking.starts_at,
        ends_at: booking.ends_at,
        timezone: booking.timezone,
        notes: booking.notes,
        client_id: booking.client_id,
        client_first_name: booking.client_first_name,
        client_last_name: booking.client_last_name ?? null,
        client_email: booking.client_email,
        client_phone: booking.client_phone ?? null,
      };
    });
  }

  // ── Session types ─────────────────────────────────────────────────────────

  async getPublicSessionTypes(): Promise<SessionTypeRecord[]> {
    const rows = await requireData<SessionTypeRecord[]>(
      this.db
        .from('session_types')
        .select('*')
        .eq('status', 'active')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
      'Failed to load public session types',
    );
    return rows;
  }

  async getAllSessionTypes(): Promise<SessionTypeRecord[]> {
    const rows = await requireData<SessionTypeRecord[]>(
      this.db
        .from('session_types')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
      'Failed to load session types',
    );
    return rows;
  }

  async createSessionType(data: NewSessionType): Promise<SessionTypeRecord> {
    const row = await requireSingle<SessionTypeRecord>(
      this.db.from('session_types').insert(data).select('*').single(),
      'Failed to create session type',
    );
    return row;
  }

  async updateSessionType(id: string, updates: SessionTypeUpdate): Promise<SessionTypeRecord> {
    const row = await requireSingle<SessionTypeRecord>(
      this.db
        .from('session_types')
        .update({ ...updates, updated_at: nowIso() })
        .eq('id', id)
        .select('*')
        .single(),
      `Failed to update session type ${id}`,
    );
    return row;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

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
    event_id: row.event_id,
    session_type_id: row.session_type_id,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    timezone: row.timezone,
    google_event_id: row.google_event_id,
    address_line: row.address_line,
    maps_url: row.maps_url,
    current_status: row.current_status,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    client_first_name: row.client?.first_name,
    client_last_name: row.client?.last_name ?? null,
    client_email: row.client?.email,
    client_phone: row.client?.phone ?? null,
    event_title: row.event?.title ?? null,
    session_type_title: row.session_type?.title ?? null,
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
