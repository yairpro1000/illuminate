import type { Booking, BookingEventSource, BookingEventType } from '../types.js';

export function bookingKind(booking: Pick<Booking, 'event_id'>): 'event' | 'session' {
  return booking.event_id ? 'event' : 'session';
}

export function toEventPayload(payload?: unknown): Record<string, unknown> {
  if (!payload) return {};
  if (typeof payload === 'object' && payload !== null) return payload as Record<string, unknown>;
  return { value: String(payload) };
}

export function isTerminalStatus(status: Booking['current_status']): boolean {
  return status === 'EXPIRED' || status === 'CANCELED' || status === 'CLOSED';
}

export function bookingEventLogContext(
  bookingId: string,
  eventType: BookingEventType,
  source: BookingEventSource,
  payload?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    booking_id: bookingId,
    event_type: eventType,
    source,
    payload_keys: Object.keys(payload ?? {}),
  };
}
