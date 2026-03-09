/**
 * Module-level singleton that holds all in-memory state for mock providers.
 * Persists across requests within a Worker isolate (wrangler dev / single instance).
 */
import type {
  Booking,
  Client,
  ContactMessage,
  Event,
  EventLateAccessLink,
  EventReminderSubscription,
  FailureLog,
  Payment,
} from '../types.js';

export interface SentEmail {
  to: string;
  subject: string;
  kind: string;
  body: string;
  sentAt: string;
}

export const mockState = {
  clients: new Map<string, Client>(),
  bookings: new Map<string, Booking>(),
  events: new Map<string, Event>(),
  eventLateAccessLinks: new Map<string, EventLateAccessLink>(),
  eventReminderSubscriptions: new Map<string, EventReminderSubscription>(),
  contactMessages: new Map<string, ContactMessage>(),
  payments: new Map<string, Payment>(),
  failureLogs: [] as FailureLog[],
  sentEmails: [] as SentEmail[],
  // booking audit/events recorded by the mock repository
  bookingEvents: [] as Array<{
    id: string;
    booking_id: string;
    event_type: string;
    source: string;
    payload?: Record<string, unknown> | null;
    created_at: string;
  }> ,
  // simple outbox for side-effects (emails, calendar ops, etc.)
  sideEffects: [] as Array<{
    id: string;
    booking_id: string;
    effect_type: string;
    payload: Record<string, unknown> | null;
    status: 'pending' | 'processing' | 'done' | 'failed';
    error_message?: string | null;
    created_at: string;
    updated_at?: string | null;
  }>,
};

const nowIso = '2026-01-01T00:00:00Z';

const SEED_EVENTS: Event[] = [
  {
    id: 'ev-01-body',
    slug: 'ev-01-body',
    title: 'Listening to the Body',
    description: 'A guided evening of embodied presence: gentle pair connection, a deep body-listening meditation, and grounded sharing.',
    starts_at: '2026-03-20T19:00:00+01:00',
    ends_at: '2026-03-20T20:55:00+01:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: false,
    price_per_person_cents: null,
    currency: 'CHF',
    capacity: 24,
    status: 'published',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    id: 'ev-02-guidance',
    slug: 'ev-02-guidance',
    title: 'Inner Compass Night',
    description: 'We explore what becomes possible when conversation is structured with care.',
    starts_at: '2026-04-17T19:00:00+02:00',
    ends_at: '2026-04-17T21:00:00+02:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: false,
    price_per_person_cents: null,
    currency: 'CHF',
    capacity: 24,
    status: 'published',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    id: 'ev-03-mirror',
    slug: 'ev-03-mirror',
    title: 'Mirrors & Gifts',
    description: 'A warm, imaginative evening where we practice affirming connection.',
    starts_at: '2026-05-15T19:00:00+02:00',
    ends_at: '2026-05-15T20:55:00+02:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: true,
    price_per_person_cents: 4500,
    currency: 'CHF',
    capacity: 24,
    status: 'published',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    id: 'ev-04-new-earth',
    slug: 'ev-04-new-earth',
    title: 'New Earth Conversations',
    description: 'A guided dialogue evening using New Earth themes as inspiration.',
    starts_at: '2026-06-19T19:00:00+02:00',
    ends_at: '2026-06-19T21:00:00+02:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: false,
    price_per_person_cents: null,
    currency: 'CHF',
    capacity: 24,
    status: 'published',
    created_at: nowIso,
    updated_at: nowIso,
  },
];

for (const ev of SEED_EVENTS) {
  mockState.events.set(ev.id, ev);
}
