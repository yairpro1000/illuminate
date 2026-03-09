import type { ICalendarProvider, CalendarEvent, CreateCalendarEventOptions } from './interface.js';
import type { TimeSlot } from '../../types.js';

/**
 * Returns a sparse set of busy periods to make available-slot generation
 * look realistic in dev without needing a real Google Calendar.
 */
function mockBusyTimes(from: string, to: string): TimeSlot[] {
  const busy: TimeSlot[] = [];
  const cur  = new Date(from + 'T12:00:00Z');
  const end  = new Date(to   + 'T12:00:00Z');

  while (cur <= end) {
    const dow = cur.getUTCDay();
    const d   = cur.getUTCDate();

    // Mondays 9:00–10:00 are always busy (e.g. admin)
    if (dow === 1) {
      const ymd = cur.toISOString().slice(0, 10);
      busy.push({ start: `${ymd}T08:00:00+01:00`, end: `${ymd}T10:00:00+01:00` });
    }

    // Every 5th weekday has an afternoon block busy
    if (dow !== 0 && dow !== 6 && d % 5 === 0) {
      const ymd = cur.toISOString().slice(0, 10);
      busy.push({ start: `${ymd}T14:00:00+01:00`, end: `${ymd}T17:00:00+01:00` });
    }

    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return busy;
}

export class MockCalendarProvider implements ICalendarProvider {
  private events = new Map<string, CalendarEvent>();

  async getBusyTimes(from: string, to: string): Promise<TimeSlot[]> {
    return mockBusyTimes(from, to);
  }

  async createEvent(event: CalendarEvent, options?: CreateCalendarEventOptions): Promise<{ eventId: string }> {
    const eventId = options?.eventIdHint ?? `mock_gcal_${crypto.randomUUID()}`;
    this.events.set(eventId, event);
    console.log(`[calendar:mock] createEvent → ${eventId}`, {
      title: event.title,
      start: event.startIso,
      end: event.endIso,
    });
    return { eventId };
  }

  async updateEvent(eventId: string, event: CalendarEvent): Promise<void> {
    this.events.set(eventId, event);
    console.log(`[calendar:mock] updateEvent ${eventId}`, {
      title: event.title,
      start: event.startIso,
    });
  }

  async deleteEvent(eventId: string): Promise<void> {
    this.events.delete(eventId);
    console.log(`[calendar:mock] deleteEvent ${eventId}`);
  }
}
