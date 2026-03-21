import type { TimeSlot } from '../../types.js';

export interface CalendarEvent {
  title: string;
  description: string;
  startIso: string;
  endIso: string;
  timezone: string;
  location: string;
  attendeeEmail: string;
  attendeeName: string;
  privateMetadata?: Record<string, string>;
}

export interface CreateCalendarEventOptions {
  /** Deterministic provider event ID for idempotent create retries. */
  eventIdHint?: string;
}

export interface CalendarEventUpsertResult {
  eventId: string;
  htmlLink: string | null;
  meetingProvider: 'google_meet' | null;
  meetingLink: string | null;
}

export class RetryableCalendarWriteError extends Error {
  readonly statusCode: number | null;
  readonly reason: string | null;

  constructor(
    message: string,
    input: { statusCode: number | null; reason: string | null },
  ) {
    super(message);
    this.name = 'RetryableCalendarWriteError';
    this.statusCode = input.statusCode;
    this.reason = input.reason;
  }
}

export function isRetryableCalendarWriteError(error: unknown): error is RetryableCalendarWriteError {
  return error instanceof RetryableCalendarWriteError;
}

export interface ICalendarProvider {
  /**
   * Returns periods when the calendar is busy between `from` and `to` (ISO 8601 dates).
   * Used to compute available booking slots.
   */
  getBusyTimes(from: string, to: string): Promise<TimeSlot[]>;

  /** Creates a calendar event. Returns the provider's event ID and meeting data when available. */
  createEvent(event: CalendarEvent, options?: CreateCalendarEventOptions): Promise<CalendarEventUpsertResult>;

  /** Updates an existing event by provider event ID and returns meeting data when available. */
  updateEvent(eventId: string, event: CalendarEvent): Promise<CalendarEventUpsertResult>;

  /** Deletes an event by provider event ID. Idempotent — must not throw if already gone. */
  deleteEvent(eventId: string): Promise<void>;
}
