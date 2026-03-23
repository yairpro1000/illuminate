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
type ExceptionLogSelector = 'none' | 'booking' | 'all_related';

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
  exceptionLogs?: ExceptionLogSelector;
}

export interface BookingReadModelSideEffect extends BookingSideEffect {
  latestAttempt: BookingSideEffectAttempt | null;
  attempts: BookingSideEffectAttempt[];
}

export interface BookingDomainSnapshot {
  booking: Booking;
  payment: Payment | null;
  selectedEvent: BookingEventRecord | null;
  events: BookingEventRecord[];
  sideEffects: BookingReadModelSideEffect[];
}

export interface BookingObservabilitySnapshot {
  apiLogs: TechnicalObservabilityRow[];
  exceptionLogs: TechnicalObservabilityRow[];
}

export interface BookingReadModel extends BookingDomainSnapshot, BookingObservabilitySnapshot {}

interface BookingReadInput {
  bookingId?: string;
  booking?: Booking | null;
}

interface BookingDomainSnapshotInput extends BookingReadInput {
  include?: Pick<BookingReadModelInclude, 'payment' | 'event' | 'sideEffects'>;
}

interface BookingObservabilitySnapshotInput extends BookingDomainSnapshot {
  include?: Pick<BookingReadModelInclude, 'apiLogs' | 'exceptionLogs'>;
}

type NormalizedDomainInclude = Required<Pick<BookingReadModelInclude, 'payment' | 'event' | 'sideEffects'>>;
type NormalizedObservabilityInclude = Required<Pick<BookingReadModelInclude, 'apiLogs' | 'exceptionLogs'>>;

const DEFAULT_DOMAIN_INCLUDE: NormalizedDomainInclude = {
  payment: 'none',
  event: { mode: 'none' },
  sideEffects: { mode: 'none' },
};

const DEFAULT_OBSERVABILITY_INCLUDE: NormalizedObservabilityInclude = {
  apiLogs: 'none',
  exceptionLogs: 'none',
};

const EMPTY_OBSERVABILITY_SNAPSHOT: BookingObservabilitySnapshot = {
  apiLogs: [],
  exceptionLogs: [],
};

export async function loadBookingWithLatestPayment(
  input: BookingReadInput,
  ctx: BookingContext,
): Promise<Pick<BookingDomainSnapshot, 'booking' | 'payment'>> {
  const snapshot = await loadBookingDomainSnapshot({
    ...input,
    include: {
      payment: 'latest',
    },
  }, ctx);

  return {
    booking: snapshot.booking,
    payment: snapshot.payment,
  };
}

export async function loadBookingWithLatestPaymentAndSelectedEvent(
  input: BookingReadInput & { event: BookingReadModelEventSelector },
  ctx: BookingContext,
): Promise<Pick<BookingDomainSnapshot, 'booking' | 'payment' | 'selectedEvent' | 'events'>> {
  const snapshot = await loadBookingDomainSnapshot({
    ...input,
    include: {
      payment: 'latest',
      event: input.event,
    },
  }, ctx);

  return {
    booking: snapshot.booking,
    payment: snapshot.payment,
    selectedEvent: snapshot.selectedEvent,
    events: snapshot.events,
  };
}

export async function loadBookingDomainSnapshot(
  input: BookingDomainSnapshotInput,
  ctx: BookingContext,
): Promise<BookingDomainSnapshot> {
  const include = normalizeDomainInclude(input.include);
  const booking = await loadBookingOrThrow(input, ctx);
  const payment = include.payment === 'latest'
    ? await ctx.providers.repository.getPaymentByBookingId(booking.id)
    : null;

  const events = shouldLoadEventList(include)
    ? await ctx.providers.repository.listBookingEvents(booking.id)
    : [];
  const selectedEvent = await resolveSelectedEvent(booking.id, include.event, events, ctx);
  const sideEffects = await loadSelectedSideEffects({
    selector: include.sideEffects,
    selectedEvent,
    events,
  }, ctx);

  return {
    booking,
    payment,
    selectedEvent,
    events,
    sideEffects,
  };
}

export async function loadBookingObservabilitySnapshot(
  input: BookingObservabilitySnapshotInput,
  ctx: BookingContext,
): Promise<BookingObservabilitySnapshot> {
  const include = normalizeObservabilityInclude(input.include);
  if (include.apiLogs === 'none' && include.exceptionLogs === 'none') {
    return EMPTY_OBSERVABILITY_SNAPSHOT;
  }

  const logScopeIds = deriveLogScopeIds({
    selectedEvent: input.selectedEvent,
    events: input.events,
    sideEffects: input.sideEffects,
    logScope: include.apiLogs,
    exceptionScope: include.exceptionLogs,
  });
  const observability = await listBookingObservabilityRows(ctx.env, {
    bookingId: input.booking.id,
    bookingEventIds: logScopeIds.bookingEventIds,
    sideEffectIds: logScopeIds.sideEffectIds,
    sideEffectAttemptIds: logScopeIds.sideEffectAttemptIds,
    includeApiLogs: include.apiLogs !== 'none',
    includeExceptionLogs: include.exceptionLogs !== 'none',
  });

  return {
    apiLogs: filterObservabilityRows(observability.apiLogs, include.apiLogs, input.booking.id),
    exceptionLogs: filterObservabilityRows(observability.exceptionLogs, include.exceptionLogs, input.booking.id),
  };
}

export async function loadBookingReadModel(
  input: BookingReadInput & { include?: BookingReadModelInclude },
  ctx: BookingContext,
): Promise<BookingReadModel> {
  const domain = await loadBookingDomainSnapshot({
    bookingId: input.bookingId,
    booking: input.booking,
    include: input.include,
  }, ctx);
  const observability = await loadBookingObservabilitySnapshot({
    ...domain,
    include: input.include,
  }, ctx);

  return {
    ...domain,
    ...observability,
  };
}

function normalizeDomainInclude(
  include?: BookingDomainSnapshotInput['include'],
): NormalizedDomainInclude {
  return {
    ...DEFAULT_DOMAIN_INCLUDE,
    ...include,
  };
}

function normalizeObservabilityInclude(
  include?: BookingObservabilitySnapshotInput['include'],
): NormalizedObservabilityInclude {
  return {
    ...DEFAULT_OBSERVABILITY_INCLUDE,
    ...include,
  };
}

async function loadBookingOrThrow(
  input: BookingReadInput,
  ctx: BookingContext,
): Promise<Booking> {
  const booking = input.booking
    ?? (input.bookingId ? await ctx.providers.repository.getBookingById(input.bookingId) : null);
  if (!booking) {
    throw new Error(`booking_not_found:${input.bookingId ?? 'missing'}`);
  }
  return booking;
}

function shouldLoadEventList(include: NormalizedDomainInclude): boolean {
  return include.event.mode === 'latest'
    || include.event.mode === 'latest_of_type'
    || include.sideEffects.mode === 'all_events';
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
  }
}

async function loadSelectedSideEffects(
  input: {
    selector: BookingReadModelSideEffectSelector;
    selectedEvent: BookingEventRecord | null;
    events: BookingEventRecord[];
  },
  ctx: BookingContext,
): Promise<BookingReadModelSideEffect[]> {
  if (input.selector.mode === 'none') return [];

  const targetEventIds = selectTargetEventIds(input.selector, input.selectedEvent, input.events);
  if (targetEventIds.length === 0) return [];

  const effects = (await ctx.providers.repository.listBookingSideEffectsForEvents(targetEventIds))
    .sort(compareByCreatedAt);
  if (effects.length === 0) return [];

  if (input.selector.attempts === 'none') {
    return effects.map((effect) => toReadModelSideEffect(effect));
  }

  const attemptMode = input.selector.attempts;
  const attempts = await ctx.providers.repository.listBookingSideEffectAttemptsForSideEffects(
    effects.map((effect) => effect.id),
  );
  const attemptsByEffectId = groupRecordsBy(attempts, (attempt) => attempt.booking_side_effect_id);

  return effects.map((effect) => {
    const effectAttempts = attemptsByEffectId.get(effect.id) ?? [];
    return toReadModelSideEffect(
      effect,
      attemptMode === 'latest' ? [] : effectAttempts,
      effectAttempts[effectAttempts.length - 1] ?? null,
    );
  });
}

function selectTargetEventIds(
  selector: BookingReadModelSideEffectSelector,
  selectedEvent: BookingEventRecord | null,
  events: BookingEventRecord[],
): string[] {
  if (selector.mode === 'none') return [];
  if (selector.mode === 'selected_event') {
    return selectedEvent ? [selectedEvent.id] : [];
  }
  return events.map((event) => event.id);
}

function toReadModelSideEffect(
  effect: BookingSideEffect,
  attempts: BookingSideEffectAttempt[] = [],
  latestAttempt: BookingSideEffectAttempt | null = null,
): BookingReadModelSideEffect {
  return {
    ...effect,
    latestAttempt,
    attempts,
  };
}

function deriveLogScopeIds(input: {
  selectedEvent: BookingEventRecord | null;
  events: BookingEventRecord[];
  sideEffects: BookingReadModelSideEffect[];
  logScope: BookingReadModelLogSelector;
  exceptionScope: ExceptionLogSelector;
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

function filterObservabilityRows(
  rows: TechnicalObservabilityRow[],
  scope: BookingReadModelLogSelector | ExceptionLogSelector,
  bookingId: string,
): TechnicalObservabilityRow[] {
  if (scope === 'none') return [];
  if (scope === 'booking') {
    return rows.filter((row) => String(row.booking_id ?? '') === bookingId);
  }
  return rows;
}

function groupRecordsBy<T>(
  rows: T[],
  keyOf: (row: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return grouped;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compareByCreatedAt<T extends { created_at: string }>(left: T, right: T): number {
  return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
}
