import type { TimeSlot } from '../../types.js';

export interface CalendarEvent {
  title: string;
  description: string;
  startIso: string;
  endIso: string;
  location: string;
  attendeeEmail: string;
  attendeeName: string;
}

export interface ICalendarProvider {
  /**
   * Returns periods when the calendar is busy between `from` and `to` (ISO 8601 dates).
   * Used to compute available booking slots.
   */
  getBusyTimes(from: string, to: string): Promise<TimeSlot[]>;

  /** Creates a calendar event. Returns the provider's event ID (google_event_id). */
  createEvent(event: CalendarEvent): Promise<{ eventId: string }>;

  /** Updates an existing event by provider event ID. */
  updateEvent(eventId: string, event: CalendarEvent): Promise<void>;

  /** Deletes an event by provider event ID. Idempotent — must not throw if already gone. */
  deleteEvent(eventId: string): Promise<void>;
}
