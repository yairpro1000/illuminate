import { listBookingObservabilityRows, type TechnicalObservabilityRow } from '../lib/technical-observability.js';
import type {
  Booking,
  BookingEventRecord,
  BookingEventType,
  BookingSideEffect,
  BookingSideEffectAttempt,
  Payment,
} from '../types.js';
import type { BookingContext } from './booking-service.js';

type PaymentInclude = 'none' | 'latest';
type AttemptInclude = 'none' | 'latest' | 'all';

export type BookingReadModelEventSelector =
  | { mode: 'none' }
  | { mode: 'by_id'; eventId: string }
  | { mode: 'latest' }
  | { mode: 'latest_of_type'; eventType: BookingEventType };

export type BookingReadModelSideEffectSelector =
  | { mode: 'none' }
  | { mode: 'selected_event'; attempts?: AttemptInclude }
  | { mode: 'all_events'; attempts?: AttemptInclude };

export type BookingReadModelLogSelector = 'none' | 'booking' | 'all_related' | 'selected_side_effects';

export interface BookingReadModelInclude {
  payment?: PaymentInclude;
  event?: BookingReadModelEventSelector;
  sideEffects?: BookingReadModelSideEffectSelector;
  apiLogs?: BookingReadModelLogSelector;
  exceptionLogs?: 'none' | 'booking' | 'all_related';
}

export interface BookingReadModelSideEffect extends BookingSideEffect {
  latestAttempt: BookingSideEffectAttempt | null;
  attempts: BookingSideEffectAttempt[];
}

export interface BookingReadModel {
  booking: Booking;
  payment: Payment | null;
  selectedEvent: BookingEventRecord | null;
  events: BookingEventRecord[];
  sideEffects: BookingReadModelSideEffect[];
  apiLogs: TechnicalObservabilityRow[];
  exceptionLogs: TechnicalObservabilityRow[];
}

const DEFAULT_INCLUDE: Required<BookingReadModelInclude> = {
  payment: 'none',
  event: { mode: 'none' },
  sideEffects: { mode: 'none' },
  apiLogs: 'none',
  exceptionLogs: 'none',
};

export async function loadBookingReadModel(
  input: {
    bookingId?: string;
    booking?: Booking | null;
    include?: BookingReadModelInclude;
  },
  ctx: BookingContext,
): Promise<BookingReadModel> {
  const include = {
    ...DEFAULT_INCLUDE,
    ...input.include,
  };
  const booking = input.booking
    ?? (input.bookingId ? await ctx.providers.repository.getBookingById(input.bookingId) : null);
  if (!booking) {
    throw new Error(`booking_not_found:${input.bookingId ?? 'missing'}`);
  }

  const payment = include.payment === 'latest'
    ? await ctx.providers.repository.getPaymentByBookingId(booking.id)
    : null;

  const eventNeedsFullList = include.event.mode === 'latest'
    || include.event.mode === 'latest_of_type'
    || include.sideEffects.mode === 'all_events';
  const events = eventNeedsFullList
    ? await ctx.providers.repository.listBookingEvents(booking.id)
    : [];
  const selectedEvent = await resolveSelectedEvent(booking.id, include.event, events, ctx);

  const sideEffects = await loadSelectedSideEffects(
    {
      selectedEvent,
      events,
      selector: include.sideEffects,
    },
    ctx,
  );

  const logScopeIds = deriveLogScopeIds({
    bookingId: booking.id,
    selectedEvent,
    events,
    sideEffects,
    logScope: include.apiLogs,
    exceptionScope: include.exceptionLogs,
  });
  const observability = await listBookingObservabilityRows(ctx.env, {
    bookingId: booking.id,
    bookingEventIds: logScopeIds.bookingEventIds,
    sideEffectIds: logScopeIds.sideEffectIds,
    sideEffectAttemptIds: logScopeIds.sideEffectAttemptIds,
    includeApiLogs: include.apiLogs !== 'none',
    includeExceptionLogs: include.exceptionLogs !== 'none',
  });

  return {
    booking,
    payment,
    selectedEvent,
    events,
    sideEffects,
    apiLogs: include.apiLogs === 'none'
      ? []
      : include.apiLogs === 'booking'
        ? observability.apiLogs.filter((row) => String(row.booking_id ?? '') === booking.id)
        : observability.apiLogs,
    exceptionLogs: include.exceptionLogs === 'none'
      ? []
      : include.exceptionLogs === 'booking'
        ? observability.exceptionLogs.filter((row) => String(row.booking_id ?? '') === booking.id)
        : observability.exceptionLogs,
  };
}

async function resolveSelectedEvent(
  bookingId: string,
  selector: BookingReadModelEventSelector,
  preloadedEvents: BookingEventRecord[],
  ctx: BookingContext,
): Promise<BookingEventRecord | null> {
  switch (selector.mode) {
    case 'none':
      return null;
    case 'by_id': {
      const event = await ctx.providers.repository.getBookingEventById(selector.eventId);
      if (event && event.booking_id !== bookingId) {
        throw new Error(`booking_event_not_owned_by_booking:${selector.eventId}`);
      }
      return event;
    }
    case 'latest':
      return preloadedEvents.length > 0
        ? preloadedEvents[preloadedEvents.length - 1] ?? null
        : await ctx.providers.repository.getLatestBookingEvent(bookingId);
    case 'latest_of_type': {
      const events = preloadedEvents.length > 0
        ? preloadedEvents
        : await ctx.providers.repository.listBookingEvents(bookingId);
      return [...events].reverse().find((event) => event.event_type === selector.eventType) ?? null;
    }
    default:
      return null;
  }
}

async function loadSelectedSideEffects(
  input: {
    selectedEvent: BookingEventRecord | null;
    events: BookingEventRecord[];
    selector: BookingReadModelSideEffectSelector;
  },
  ctx: BookingContext,
): Promise<BookingReadModelSideEffect[]> {
  if (input.selector.mode === 'none') return [];

  const targetEvents = input.selector.mode === 'selected_event'
    ? (input.selectedEvent ? [input.selectedEvent] : [])
    : input.events;
  const effects = (
    await Promise.all(targetEvents.map((event) => ctx.providers.repository.listBookingSideEffectsForEvent(event.id)))
  ).flat().sort(compareByCreatedAt);

  if (input.selector.attempts === 'none' || effects.length === 0) {
    return effects.map((effect) => ({
      ...effect,
      latestAttempt: null,
      attempts: [],
    }));
  }

  if (input.selector.attempts === 'latest') {
    const latestAttempts = await Promise.all(
      effects.map((effect) => ctx.providers.repository.getLastBookingSideEffectAttempt(effect.id)),
    );
    return effects.map((effect, index) => ({
      ...effect,
      latestAttempt: latestAttempts[index] ?? null,
      attempts: [],
    }));
  }

  const attempts = await Promise.all(
    effects.map((effect) => ctx.providers.repository.listBookingSideEffectAttempts(effect.id)),
  );
  return effects.map((effect, index) => {
    const effectAttempts = attempts[index] ?? [];
    return {
      ...effect,
      latestAttempt: effectAttempts.length > 0 ? effectAttempts[effectAttempts.length - 1] ?? null : null,
      attempts: effectAttempts,
    };
  });
}

function deriveLogScopeIds(input: {
  bookingId: string;
  selectedEvent: BookingEventRecord | null;
  events: BookingEventRecord[];
  sideEffects: BookingReadModelSideEffect[];
  logScope: BookingReadModelLogSelector;
  exceptionScope: 'none' | 'booking' | 'all_related';
}): {
  bookingEventIds: string[];
  sideEffectIds: string[];
  sideEffectAttemptIds: string[];
} {
  const selectedEventIds = input.selectedEvent ? [input.selectedEvent.id] : [];
  const allEventIds = input.events.map((event) => event.id);
  const relatedEventIds = input.logScope === 'selected_side_effects'
    ? selectedEventIds
    : uniqueStrings([...selectedEventIds, ...allEventIds]);
  const includeRelatedIds = input.logScope === 'all_related'
    || input.logScope === 'selected_side_effects'
    || input.exceptionScope === 'all_related';
  const sideEffectIds = includeRelatedIds ? input.sideEffects.map((effect) => effect.id) : [];
  const sideEffectAttemptIds = includeRelatedIds
    ? input.sideEffects.flatMap((effect) => [
        ...effect.attempts.map((attempt) => attempt.id),
        ...(effect.latestAttempt ? [effect.latestAttempt.id] : []),
      ])
    : [];

  return {
    bookingEventIds: includeRelatedIds ? relatedEventIds : [],
    sideEffectIds: uniqueStrings(sideEffectIds),
    sideEffectAttemptIds: uniqueStrings(sideEffectAttemptIds),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compareByCreatedAt<
  T extends { created_at: string },
>(left: T, right: T): number {
  return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
}
