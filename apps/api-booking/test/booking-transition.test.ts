import { describe, it, expect } from 'vitest';
import type { Booking } from '../src/types.js';
import { mapLegacyToState } from '../src/domain/booking-domain.js';

function baseBooking(partial: Partial<Booking>): Booking {
  return {
    id: 'b',
    client_id: 'c',
    source: 'session',
    status: 'pending_email',
    event_id: null,
    session_type: 'session',
    starts_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
    timezone: 'Europe/Zurich',
    address_line: 'addr',
    maps_url: 'maps',
    attended: false,
    notes: null,
    confirm_token_hash: null,
    confirm_expires_at: null,
    manage_token_hash: 'm',
    checkout_session_id: null,
    checkout_hold_expires_at: null,
    payment_due_at: null,
    payment_due_reminder_scheduled_at: null,
    payment_due_reminder_sent_at: null,
    followup_scheduled_at: null,
    followup_sent_at: null,
    reminder_email_opt_in: false,
    reminder_whatsapp_opt_in: false,
    reminder_24h_scheduled_at: null,
    reminder_24h_sent_at: null,
    google_event_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

describe('mapLegacyToState', () => {
  it('maps pay_now pending to pending lifecycle with reserved hold', () => {
    const b = baseBooking({ status: 'pending_payment', checkout_hold_expires_at: new Date(Date.now() + 10_000).toISOString() });
    const s = mapLegacyToState(b);
    expect(s.booking_status).toBe('pending');
    expect(s.payment_mode).toBe('pay_now');
    expect(s.payment_status_v2).toBe('pending');
    expect(s.slot_status).toBe('reserved');
  });

  it('maps pay_later confirmed (legacy pending_payment with payment_due_at) to confirmed lifecycle', () => {
    const b = baseBooking({ status: 'pending_payment', payment_due_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), checkout_hold_expires_at: null });
    const s = mapLegacyToState(b);
    expect(s.booking_status).toBe('confirmed');
    expect(s.payment_mode).toBe('pay_later');
    expect(s.payment_status_v2).toBe('pending');
  });

  it('maps free intro after confirmation to confirmed with not_required payment', () => {
    const b = baseBooking({ session_type: 'intro', status: 'confirmed' });
    const s = mapLegacyToState(b);
    expect(s.booking_status).toBe('confirmed');
    expect(s.payment_mode).toBe('free');
    expect(s.payment_status_v2).toBe('not_required');
  });
});
