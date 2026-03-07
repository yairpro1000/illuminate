/**
 * Module-level singleton that holds all in-memory state for mock providers.
 * Persists across requests within a Worker isolate (wrangler dev / single instance).
 * Intentionally wiped on cold start — fine for dev/testing purposes.
 */
import type {
  Booking, Event, EventAttendee, EventRegistration,
  FailureLog, JobRun, Payment,
} from '../types.js';

export interface SentEmail {
  to: string;
  subject: string;
  kind: string;
  body: string;
  sentAt: string;
}

export const mockState = {
  bookings:      new Map<string, Booking>(),
  events:        new Map<string, Event>(),
  registrations: new Map<string, EventRegistration>(),
  attendees:     new Map<string, EventAttendee>(),
  payments:      new Map<string, Payment>(),
  failureLogs:   [] as FailureLog[],
  jobRuns:       new Map<string, JobRun>(),
  sentEmails:    [] as SentEmail[],
};

// ── Seed events from the static JSON data ────────────────────────────────────
// Mirrors apps/site/data/events_data.json; update when events change.

const SEED_EVENTS: Event[] = [
  {
    id: 'ev-01-body',
    slug: 'ev-01-body',
    title: 'Listening to the Body',
    description: 'A guided evening of embodied presence: gentle pair connection, a deep body-listening meditation, and grounded sharing.',
    starts_at: '2026-03-20T19:00:00+01:00',
    ends_at:   '2026-03-20T20:55:00+01:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: false,
    price_per_person_cents: null,
    currency: 'CHF',
    capacity: null,
    status: 'published',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'ev-02-guidance',
    slug: 'ev-02-guidance',
    title: 'Inner Compass Night',
    description: 'We explore what becomes possible when conversation is structured with care.',
    starts_at: '2026-04-17T19:00:00+02:00',
    ends_at:   '2026-04-17T21:00:00+02:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: false,
    price_per_person_cents: null,
    currency: 'CHF',
    capacity: null,
    status: 'published',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'ev-03-mirror',
    slug: 'ev-03-mirror',
    title: 'Mirrors & Gifts',
    description: 'A warm, imaginative evening where we practice affirming connection.',
    starts_at: '2026-05-15T19:00:00+02:00',
    ends_at:   '2026-05-15T20:55:00+02:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: false,
    price_per_person_cents: null,
    currency: 'CHF',
    capacity: null,
    status: 'published',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'ev-04-new-earth',
    slug: 'ev-04-new-earth',
    title: 'New Earth Conversations',
    description: 'A guided dialogue evening using New Earth themes as inspiration.',
    starts_at: '2026-06-19T19:00:00+02:00',
    ends_at:   '2026-06-19T21:00:00+02:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: false,
    price_per_person_cents: null,
    currency: 'CHF',
    capacity: null,
    status: 'published',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

for (const ev of SEED_EVENTS) {
  mockState.events.set(ev.id, ev);
}
