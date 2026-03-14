import type { Db } from '../../repo/supabase.js';
import type { AdminContactMessageFilters, OrganizerBookingFilters, IRepository } from './interface.js';
import type {
  Booking,
  BookingEventRecord,
  BookingSideEffect,
  BookingSideEffectAttempt,
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
  TimeSlot,
  SessionTypeRecord,
  NewSessionType,
  SessionTypeUpdate,
  SystemSetting,
  NewSystemSetting,
  SystemSettingUpdate,
} from '../../types.js';
import { conflict } from '../../lib/errors.js';
import {
  isEventPubliclyListed,
  normalizeEventRow,
  normalizeEventUpdateForDb,
  normalizeSessionTypeRow,
  normalizeSessionTypeUpdateForDb,
  toDbSessionTypeStatus,
} from '../../lib/content-status.js';

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

const CONTACT_MESSAGE_SELECT = `
  *,
  client:clients!contact_messages_client_id_fkey (
    first_name,
    last_name,
    email,
    phone
  )
`;

type ContactMessageRow = ContactMessage & {
  client?: {
    first_name: string;
    last_name: string | null;
    email: string;
    phone: string | null;
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

  async listClientsByEmailPrefix(prefix: string): Promise<Client[]> {
    const normalizedPrefix = normalizeEmail(prefix).replace(/[%_]/g, (match) => `\\${match}`);
    return requireData<Client[]>(
      this.db
        .from('clients')
        .select('*')
        .ilike('email', `${normalizedPrefix}%`)
        .order('email', { ascending: true }),
      'Failed to load clients by email prefix',
    );
  }

  async listBookingsByClientTagPrefix(prefix: string): Promise<Booking[]> {
    const normalizedPrefix = normalizeEmail(prefix).replace(/[%_]/g, (match) => `\\${match}`);
    const emailClients = await requireData<Client[]>(
      this.db
        .from('clients')
        .select('*')
        .ilike('email', `${normalizedPrefix}%`)
        .order('email', { ascending: true }),
      'Failed to load clients by email prefix',
    );
    const firstNameClients = await requireData<Client[]>(
      this.db
        .from('clients')
        .select('*')
        .ilike('first_name', `${normalizedPrefix}%`)
        .order('first_name', { ascending: true }),
      'Failed to load clients by first-name prefix',
    );
    const clientIds = [...new Set([...emailClients, ...firstNameClients].map((client) => client.id))];
    if (clientIds.length === 0) return [];

    const rows = await requireData<BookingRow[]>(
      this.db
        .from('bookings')
        .select(BOOKING_SELECT)
        .in('client_id', clientIds)
        .order('starts_at', { ascending: true }),
      'Failed to load bookings by client tag prefix',
    );
    return rows.map((row) => toBooking(row));
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

  async getCouponByCode(code: string): Promise<Coupon | null> {
    return maybeSingle<Coupon>(
      this.db.from('coupons').select('*').eq('code', code).limit(1).maybeSingle(),
      `Failed to load coupon ${code}`,
    );
  }

  // ── Bookings ──────────────────────────────────────────────────────────────

  async createBooking(data: NewBooking): Promise<Booking> {
    let created: { id: string };
    try {
      created = await requireSingle<{ id: string }>(
        this.db.from('bookings').insert(data).select('id').single(),
        'Failed to create booking',
      );
    } catch (error) {
      if (isActiveSlotOverlapError(error)) {
        throw conflict('This slot is no longer available');
      }
      throw error;
    }
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
        .in('current_status', ['PENDING', 'CONFIRMED'])
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

  async updateBookingEventCreatedAt(eventId: string, createdAt: string): Promise<BookingEventRecord> {
    return requireSingle<BookingEventRecord>(
      this.db
        .from('booking_events')
        .update({ created_at: createdAt })
        .eq('id', eventId)
        .select('*')
        .single(),
      `Failed to update booking event ${eventId}`,
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
        .in('status', ['PENDING', 'FAILED'])
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

  async deleteBookingSideEffect(id: string): Promise<void> {
    await requireData<Array<{ id: string }>>(
      this.db.from('booking_side_effects').delete().eq('id', id).select('id'),
      `Failed to delete booking side effect ${id}`,
    );
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
    const timeoutMinutes = await this.getRequiredIntegerSystemSetting('sideEffectProcessingTimeoutMinutes');
    const threshold = new Date(
      new Date(nowIsoValue).getTime() - timeoutMinutes * 60_000,
    ).toISOString();

    const rows = await requireData<Array<{ id: string }>>(
      this.db
        .from('booking_side_effects')
        .update({ status: 'PENDING', updated_at: nowIsoValue })
        .eq('status', 'PROCESSING')
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
      this.db
        .from('events')
        .select('*')
        .in('status', ['published', 'PUBLISHED', 'sold_out', 'SOLD_OUT'])
        .order('starts_at', { ascending: true }),
      'Failed to load published events',
    );
    return rows
      .map((row) => normalizeEventRow(row))
      .filter((row) => isEventPubliclyListed(row.status));
  }

  async getAllEvents(): Promise<Event[]> {
    const rows = await requireData<Event[]>(
      this.db.from('events').select('*').order('starts_at', { ascending: false }),
      'Failed to load all events',
    );
    return rows.map((row) => normalizeEventRow(row));
  }

  async updateEvent(id: string, updates: import('../../types.js').EventUpdate): Promise<Event> {
    const row = await requireSingle<Event>(
      this.db.from('events').update(normalizeEventUpdateForDb(updates)).eq('id', id).select().single(),
      'Failed to update event',
    );
    return normalizeEventRow(row);
  }

  async getEventBySlug(slug: string): Promise<Event | null> {
    const row = await maybeSingle<Event>(
      this.db.from('events').select('*').eq('slug', slug).limit(1).maybeSingle(),
      'Failed to load event by slug',
    );
    return row ? normalizeEventRow(row) : null;
  }

  async getEventById(id: string): Promise<Event | null> {
    const row = await maybeSingle<Event>(
      this.db.from('events').select('*').eq('id', id).limit(1).maybeSingle(),
      'Failed to load event',
    );
    return row ? normalizeEventRow(row) : null;
  }

  async countEventActiveBookings(eventId: string, _nowIso: string): Promise<number> {
    const rows = await requireData<Array<Pick<Booking, 'current_status'>>>(
      this.db
        .from('bookings')
        .select('current_status')
        .eq('event_id', eventId)
        .not('current_status', 'in', '(EXPIRED,CANCELED,COMPLETED,NO_SHOW)'),
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

  async getAdminContactMessages(filters: AdminContactMessageFilters): Promise<AdminContactMessageRow[]> {
    let query: any = this.db
      .from('contact_messages')
      .select(CONTACT_MESSAGE_SELECT)
      .order('created_at', { ascending: false });

    if (filters.client_id) query = query.eq('client_id', filters.client_id);
    if (filters.date) {
      query = query
        .gte('created_at', startOfDayIso(filters.date))
        .lte('created_at', endOfDayIso(filters.date));
    }

    const rows = await requireData<ContactMessageRow[]>(query, 'Failed to load admin contact messages');
    let result = rows
      .filter((row) => row.client)
      .map((row) => ({
        id: row.id,
        client_id: row.client_id,
        topic: row.topic,
        message: row.message,
        status: row.status,
        source: row.source,
        created_at: row.created_at,
        updated_at: row.updated_at,
        client_first_name: row.client!.first_name,
        client_last_name: row.client!.last_name,
        client_email: row.client!.email,
        client_phone: row.client!.phone,
      }));

    if (filters.q) {
      const q = filters.q.toLowerCase();
      result = result.filter((row) => {
        const haystack = [
          row.client_first_name,
          row.client_last_name,
          row.client_email,
          row.client_phone,
          row.topic,
          row.message,
          row.status,
          row.source,
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    return result;
  }

  // ── Organizer reads ───────────────────────────────────────────────────────

  async getOrganizerBookings(filters: OrganizerBookingFilters): Promise<OrganizerBookingRow[]> {
    let query: any = this.db.from('bookings').select(BOOKING_SELECT).order('starts_at', { ascending: true });

    if (filters.event_id) query = query.eq('event_id', filters.event_id);
    if (filters.client_id) query = query.eq('client_id', filters.client_id);
    if (filters.client_ids && filters.client_ids.length > 0) query = query.in('client_id', filters.client_ids);
    if (filters.current_status) query = query.eq('current_status', filters.current_status);
    if (filters.booking_kind === 'event') query = query.not('event_id', 'is', null);
    if (filters.booking_kind === 'session') query = query.is('event_id', null);
    if (filters.date) {
      query = query
        .gte('starts_at', startOfDayIso(filters.date))
        .lte('starts_at', endOfDayIso(filters.date));
    }

    const rows = await requireData<BookingRow[]>(query, 'Failed to load organizer bookings');
    const bookings = rows.map((row) => toBooking(row));
    const bookingIds = bookings.map((booking) => booking.id);
    const eventByBooking = new Map<string, { event_type: OrganizerBookingRow['latest_event_type']; created_at: string }>();
    const paymentEventByBooking = new Map<string, { event_type: OrganizerBookingRow['payment_latest_event_type']; created_at: string }>();
    const paymentByBooking = new Map<string, { amount_cents: number; currency: string; status: OrganizerBookingRow['payment_status'] }>();
    const latestAttemptByBooking = new Map<string, { status: OrganizerBookingRow['latest_side_effect_attempt_status']; created_at: string }>();
    const paymentAttemptByBooking = new Map<string, { status: OrganizerBookingRow['payment_latest_side_effect_attempt_status']; created_at: string }>();

    if (bookingIds.length > 0) {
      const bookingEvents = await requireData<Array<{
        id: string;
        booking_id: string;
        event_type: OrganizerBookingRow['latest_event_type'];
        created_at: string;
      }>>(
        this.db
          .from('booking_events')
          .select('id, booking_id, event_type, created_at')
          .in('booking_id', bookingIds)
          .order('created_at', { ascending: false }),
        'Failed to load organizer booking events',
      );

      const bookingEventIds: string[] = [];
      for (const bookingEvent of bookingEvents) {
        bookingEventIds.push(bookingEvent.id);
        if (!eventByBooking.has(bookingEvent.booking_id)) {
          eventByBooking.set(bookingEvent.booking_id, {
            event_type: bookingEvent.event_type,
            created_at: bookingEvent.created_at,
          });
        }
        if (
          !paymentEventByBooking.has(bookingEvent.booking_id)
          && isPaymentRelatedBookingEventType(bookingEvent.event_type)
        ) {
          paymentEventByBooking.set(bookingEvent.booking_id, {
            event_type: bookingEvent.event_type,
            created_at: bookingEvent.created_at,
          });
        }
      }

      const payments = await requireData<Array<{
        booking_id: string;
        amount_cents: number;
        currency: string;
        status: OrganizerBookingRow['payment_status'];
        created_at: string;
      }>>(
        this.db
          .from('payments')
          .select('booking_id, amount_cents, currency, status, created_at')
          .in('booking_id', bookingIds)
          .order('created_at', { ascending: false }),
        'Failed to load organizer booking payments',
      );
      for (const payment of payments) {
        if (!paymentByBooking.has(payment.booking_id)) {
          paymentByBooking.set(payment.booking_id, {
            amount_cents: payment.amount_cents,
            currency: payment.currency,
            status: payment.status,
          });
        }
      }

      if (bookingEventIds.length > 0) {
        const sideEffects = await requireData<Array<{
          id: string;
          booking_event_id: string;
          effect_intent: string;
          created_at: string;
        }>>(
          this.db
            .from('booking_side_effects')
            .select('id, booking_event_id, effect_intent, created_at')
            .in('booking_event_id', bookingEventIds)
            .order('created_at', { ascending: false }),
          'Failed to load organizer booking side effects',
        );

        const bookingIdBySideEffectId = new Map<string, string>();
        const paymentSideEffectIds = new Set<string>();
        const bookingIdByEventId = new Map<string, string>();
        for (const event of bookingEvents) bookingIdByEventId.set(event.id, event.booking_id);
        for (const sideEffect of sideEffects) {
          const ownerBookingId = bookingIdByEventId.get(sideEffect.booking_event_id);
          if (!ownerBookingId) continue;
          bookingIdBySideEffectId.set(sideEffect.id, ownerBookingId);
          if (isPaymentRelatedSideEffectIntent(sideEffect.effect_intent)) {
            paymentSideEffectIds.add(sideEffect.id);
          }
        }

        const sideEffectIds = sideEffects.map((effect) => effect.id);
        if (sideEffectIds.length > 0) {
          const attempts = await requireData<Array<{
            booking_side_effect_id: string;
            status: OrganizerBookingRow['latest_side_effect_attempt_status'];
            created_at: string;
          }>>(
            this.db
              .from('booking_side_effect_attempts')
              .select('booking_side_effect_id, status, created_at')
              .in('booking_side_effect_id', sideEffectIds)
              .order('created_at', { ascending: false }),
            'Failed to load organizer booking side effect attempts',
          );

          for (const attempt of attempts) {
            const ownerBookingId = bookingIdBySideEffectId.get(attempt.booking_side_effect_id);
            if (!ownerBookingId) continue;
            if (!latestAttemptByBooking.has(ownerBookingId)) {
              latestAttemptByBooking.set(ownerBookingId, {
                status: attempt.status,
                created_at: attempt.created_at,
              });
            }
            if (
              paymentSideEffectIds.has(attempt.booking_side_effect_id)
              && !paymentAttemptByBooking.has(ownerBookingId)
            ) {
              paymentAttemptByBooking.set(ownerBookingId, {
                status: attempt.status,
                created_at: attempt.created_at,
              });
            }
          }
        }
      }
    }

    return bookings.map((booking) => {
      if (!booking.client_first_name || !booking.client_email) {
        throw new Error(`Booking ${booking.id} is missing organizer join data`);
      }
      const latestEvent = eventByBooking.get(booking.id);
      const latestAttempt = latestAttemptByBooking.get(booking.id);
      const payment = paymentByBooking.get(booking.id);
      const paymentEvent = paymentEventByBooking.get(booking.id);
      const paymentAttempt = paymentAttemptByBooking.get(booking.id);

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
        google_event_id: booking.google_event_id,
        address_line: booking.address_line,
        maps_url: booking.maps_url,
        payment_amount_cents: payment?.amount_cents ?? null,
        payment_currency: payment?.currency ?? null,
        payment_status: payment?.status ?? null,
        latest_event_type: latestEvent?.event_type ?? null,
        latest_event_at: latestEvent?.created_at ?? null,
        latest_side_effect_attempt_status: latestAttempt?.status ?? null,
        latest_side_effect_attempt_at: latestAttempt?.created_at ?? null,
        payment_latest_event_type: paymentEvent?.event_type ?? null,
        payment_latest_event_at: paymentEvent?.created_at ?? null,
        payment_latest_side_effect_attempt_status: paymentAttempt?.status ?? null,
        payment_latest_side_effect_attempt_at: paymentAttempt?.created_at ?? null,
        notes: booking.notes,
        created_at: booking.created_at,
        updated_at: booking.updated_at,
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
        .in('status', ['active', 'ACTIVE'])
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
      'Failed to load public session types',
    );
    return rows.map((row) => normalizeSessionTypeRow(row));
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
    return rows.map((row) => normalizeSessionTypeRow(row));
  }

  async createSessionType(data: NewSessionType): Promise<SessionTypeRecord> {
    const row = await requireSingle<SessionTypeRecord>(
      this.db
        .from('session_types')
        .insert({ ...data, status: toDbSessionTypeStatus(data.status) })
        .select('*')
        .single(),
      'Failed to create session type',
    );
    return normalizeSessionTypeRow(row);
  }

  async updateSessionType(id: string, updates: SessionTypeUpdate): Promise<SessionTypeRecord> {
    const row = await requireSingle<SessionTypeRecord>(
      this.db
        .from('session_types')
        .update({ ...normalizeSessionTypeUpdateForDb(updates), updated_at: nowIso() })
        .eq('id', id)
        .select('*')
        .single(),
      `Failed to update session type ${id}`,
    );
    return normalizeSessionTypeRow(row);
  }

  async listSystemSettings(): Promise<SystemSetting[]> {
    return requireData<SystemSetting[]>(
      this.db
        .from('system_settings')
        .select('*')
        .order('domain', { ascending: true })
        .order('keyname', { ascending: true }),
      'Failed to load system settings',
    );
  }

  async listSystemSettingDomains(): Promise<string[]> {
    const rows = await requireData<Array<Pick<SystemSetting, 'domain'>>>(
      this.db
        .from('system_settings')
        .select('domain')
        .order('domain', { ascending: true }),
      'Failed to load system setting domains',
    );
    return [...new Set(rows.map((row) => row.domain))];
  }

  async createSystemSetting(data: NewSystemSetting): Promise<SystemSetting> {
    return requireSingle<SystemSetting>(
      this.db
        .from('system_settings')
        .insert({
          ...data,
          unit: data.unit ?? null,
          description_he: data.description_he ?? null,
        })
        .select('*')
        .single(),
      `Failed to create system setting ${data.keyname}`,
    );
  }

  async updateSystemSetting(existingKeyname: string, updates: SystemSettingUpdate): Promise<SystemSetting> {
    return requireSingle<SystemSetting>(
      this.db
        .from('system_settings')
        .update({
          ...updates,
          updated_at: nowIso(),
        })
        .eq('keyname', existingKeyname)
        .select('*')
        .single(),
      `Failed to update system setting ${existingKeyname}`,
    );
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async requireBookingById(id: string): Promise<Booking> {
    const booking = await this.getBookingById(id);
    if (!booking) throw new Error(`Booking ${id} not found after write`);
    return booking;
  }

  private async getRequiredIntegerSystemSetting(keyname: string): Promise<number> {
    const row = await maybeSingle<Pick<SystemSetting, 'keyname' | 'value'>>(
      this.db
        .from('system_settings')
        .select('keyname, value')
        .eq('keyname', keyname)
        .limit(1)
        .maybeSingle(),
      `Failed to load system setting ${keyname}`,
    );
    if (!row) throw new Error(`System setting ${keyname} not found`);
    const parsed = Number(row.value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`System setting ${keyname} is not a positive integer`);
    }
    return parsed;
  }
}

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    client_id: row.client_id,
    event_id: row.event_id,
    session_type_id: row.session_type_id,
    booking_type: row.booking_type,
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

function isPaymentRelatedBookingEventType(eventType: OrganizerBookingRow['latest_event_type']): boolean {
  return eventType === 'PAYMENT_SETTLED'
    || eventType === 'REFUND_COMPLETED';
}

function isPaymentRelatedSideEffectIntent(effectIntent: string): boolean {
  return effectIntent.includes('stripe') || effectIntent.includes('payment');
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
  promise: PromiseLike<{ data: T | null; error: QueryError | null }>,
  message: string,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${message}: ${formatQueryError(error)}`);
  if (data === null) throw new Error(message);
  return data;
}

async function maybeSingle<T>(
  promise: PromiseLike<{ data: T | null; error: QueryError | null }>,
  message: string,
): Promise<T | null> {
  const { data, error } = await promise;
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`${message}: ${formatQueryError(error)}`);
  }
  return data;
}

async function requireData<T>(
  promise: PromiseLike<{ data: T | null; error: QueryError | null }>,
  message: string,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${message}: ${formatQueryError(error)}`);
  if (data === null) throw new Error(message);
  return data;
}

interface QueryError {
  code?: string;
  details?: string | null;
  hint?: string | null;
  message: string;
  status?: number;
}

function formatQueryError(error: QueryError): string {
  const parts = [error.message];
  if (error.code) parts.push(`code=${error.code}`);
  if (error.details) parts.push(`details=${error.details}`);
  if (error.hint) parts.push(`hint=${error.hint}`);
  if (typeof error.status === 'number') parts.push(`status=${error.status}`);
  return parts.join(' | ');
}

function isActiveSlotOverlapError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('no_overlapping_active_bookings')
    || error.message.includes('code=23P01')
    || error.message.includes('conflicting key value violates exclusion constraint');
}
