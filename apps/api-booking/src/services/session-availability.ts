import { ApiError, badRequest } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type {
  SessionTypeAvailabilityWindow,
  SessionTypeRecord,
  SessionTypeWeekOverride,
  SessionTypeWeekOverrideMode,
  TimeSlot,
} from '../types.js';
import type { IRepository } from '../providers/repository/interface.js';

const LOCAL_WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

const INTRO_STARTS = [9, 10, 11, 12, 14, 15, 16, 17, 18, 19];
const INTRO_DURATION_MINUTES = 30;
const SESSION_STARTS = [9, 11, 14, 16, 18];
const SESSION_DURATION_MINUTES = 90;

export interface SessionTypeWeekCapacityDecision {
  weekStartDate: string;
  weekEndExclusiveDate: string;
  weekStartInclusiveIso: string;
  weekEndExclusiveIso: string;
  overrideMode: SessionTypeWeekOverrideMode;
  overrideWeeklyLimit: number | null;
  effectiveWeeklyLimit: number | null;
  activeBookingCount: number;
  allowsMoreBookings: boolean;
  branchTaken: string;
  denyReason: string | null;
}

export interface SessionTypeAvailabilityWeekSummary extends SessionTypeWeekCapacityDecision {
  remainingCapacity: number | null;
  note: string | null;
  updatedBy: string | null;
}

export interface SessionTypeAvailabilityDetails {
  mode: SessionTypeRecord['availability_mode'];
  timezone: string;
  weeklyBookingLimit: number | null;
  slotStepMinutes: number | null;
  windows: SessionTypeAvailabilityWindow[];
}

interface SlotCandidate {
  start: string;
  end: string;
}

function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value).trim());
  if (!match) {
    throw badRequest('Availability times must use HH:MM format', 'INVALID_SESSION_TYPE_AVAILABILITY_WINDOW');
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function weekdayIsoForDate(date: string): number {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function localDateString(iso: string, timezone: string): { date: string; weekdayIndex: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(iso));

  const year = parts.find((part) => part.type === 'year')?.value ?? '2000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';

  return {
    date: `${year}-${month}-${day}`,
    weekdayIndex: LOCAL_WEEKDAY_INDEX[weekday] ?? 0,
  };
}

export function shiftIsoDate(date: string, days: number): string {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function getUtcOffsetMinutes(timezone: string, date: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
  const localHour = get('hour');
  const localMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    localHour === 24 ? 0 : localHour,
    get('minute'),
    get('second'),
  );
  return (localMs - date.getTime()) / 60000;
}

export function localDateTimeToIso(date: string, hour: number, minute: number, timezone: string): string {
  const reference = new Date(`${date}T12:00:00Z`);
  const offsetMinutes = getUtcOffsetMinutes(timezone, reference);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const absMinutes = Math.abs(offsetMinutes) % 60;

  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${sign}${String(absHours).padStart(2, '0')}:${String(absMinutes).padStart(2, '0')}`;
}

export function localWeekRangeForSlot(slotStartIso: string, timezone: string): {
  weekStartDate: string;
  weekEndExclusiveDate: string;
  startInclusiveIso: string;
  endExclusiveIso: string;
} {
  const local = localDateString(slotStartIso, timezone);
  const weekStartDate = shiftIsoDate(local.date, -local.weekdayIndex);
  const weekEndExclusiveDate = shiftIsoDate(weekStartDate, 7);

  return {
    weekStartDate,
    weekEndExclusiveDate,
    startInclusiveIso: localDateTimeToIso(weekStartDate, 0, 0, timezone),
    endExclusiveIso: localDateTimeToIso(weekEndExclusiveDate, 0, 0, timezone),
  };
}

export async function resolvePublicSessionTypeForBooking(
  repository: Pick<IRepository, 'getPublicSessionTypes'>,
  input: {
    kind: 'intro' | 'session';
    offerSlug?: string | null;
    sessionTypeId?: string | null;
  },
): Promise<SessionTypeRecord> {
  const all = await repository.getPublicSessionTypes();
  if (all.length === 0) {
    throw badRequest('No active session types configured');
  }

  const explicitById = input.sessionTypeId
    ? all.find((row) => row.id === input.sessionTypeId)
    : null;
  const introCandidate = all.find((row) => row.slug.includes('intro') || row.price === 0);
  const explicitOffer = input.offerSlug && input.kind === 'session'
    ? all.find((row) => row.slug === input.offerSlug)
    : null;
  const paidCandidate = all.find((row) => row.id !== introCandidate?.id) ?? all[0];

  const selected = explicitById
    ?? (input.kind === 'intro'
      ? (introCandidate ?? all[0])
      : (explicitOffer ?? paidCandidate ?? all[0]));
  if (!selected) {
    throw badRequest('Unable to resolve session type');
  }
  return selected;
}

export async function loadSessionTypeAvailabilityDetails(
  repository: Pick<IRepository, 'listSessionTypeAvailabilityWindows'>,
  sessionType: SessionTypeRecord,
  fallbackTimezone: string,
): Promise<SessionTypeAvailabilityDetails> {
  const timezone = sessionType.availability_timezone?.trim() || fallbackTimezone;
  const windows = sessionType.availability_mode === 'dedicated'
    ? await repository.listSessionTypeAvailabilityWindows(sessionType.id)
    : [];

  return {
    mode: sessionType.availability_mode,
    timezone,
    weeklyBookingLimit: sessionType.weekly_booking_limit,
    slotStepMinutes: sessionType.slot_step_minutes,
    windows,
  };
}

async function loadWeekOverridesMap(
  repository: Pick<IRepository, 'listSessionTypeWeekOverrides'>,
  sessionTypeId: string,
  weekStartDateFrom: string,
  weekStartDateTo: string,
): Promise<Map<string, SessionTypeWeekOverride>> {
  const rows = await repository.listSessionTypeWeekOverrides(sessionTypeId, weekStartDateFrom, weekStartDateTo);
  return new Map(rows.map((row) => [row.week_start_date, row]));
}

function getSharedDefaultCandidates(
  date: string,
  kind: 'intro' | 'session',
  timezone: string,
): SlotCandidate[] {
  const startHours = kind === 'intro' ? INTRO_STARTS : SESSION_STARTS;
  const durationMinutes = kind === 'intro' ? INTRO_DURATION_MINUTES : SESSION_DURATION_MINUTES;
  return startHours.map((hour) => {
    const start = localDateTimeToIso(date, hour, 0, timezone);
    const endMs = new Date(start).getTime() + durationMinutes * 60_000;
    return {
      start,
      end: new Date(endMs).toISOString(),
    };
  });
}

function getDedicatedCandidates(
  date: string,
  sessionType: SessionTypeRecord,
  details: SessionTypeAvailabilityDetails,
): SlotCandidate[] {
  const windowsForDay = details.windows.filter((window) => window.active && window.weekday_iso === weekdayIsoForDate(date));
  if (windowsForDay.length === 0) {
    return [];
  }

  const durationMinutes = sessionType.duration_minutes;
  const stepMinutes = details.slotStepMinutes ?? durationMinutes;
  const candidates: SlotCandidate[] = [];

  for (const window of windowsForDay) {
    const startTime = parseTimeOfDay(window.start_local_time);
    const endTime = parseTimeOfDay(window.end_local_time);
    const startMinutes = startTime.hour * 60 + startTime.minute;
    const endMinutes = endTime.hour * 60 + endTime.minute;

    for (let minuteOfDay = startMinutes; minuteOfDay + durationMinutes <= endMinutes; minuteOfDay += stepMinutes) {
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      const start = localDateTimeToIso(date, hour, minute, details.timezone);
      const endMs = new Date(start).getTime() + durationMinutes * 60_000;
      candidates.push({
        start,
        end: new Date(endMs).toISOString(),
      });
    }
  }

  return candidates;
}

function overlapsBusyTime(candidate: SlotCandidate, busyTimes: TimeSlot[]): boolean {
  const startMs = new Date(candidate.start).getTime();
  const endMs = new Date(candidate.end).getTime();
  return busyTimes.some((busy) => {
    const busyStartMs = new Date(busy.start).getTime();
    const busyEndMs = new Date(busy.end).getTime();
    return startMs < busyEndMs && endMs > busyStartMs;
  });
}

function passesLeadTime(candidate: SlotCandidate, slotLeadTimeHours: number, nowMs: number): boolean {
  const startMs = new Date(candidate.start).getTime();
  return startMs >= nowMs + slotLeadTimeHours * 60 * 60 * 1000;
}

function decisionForOverride(
  override: SessionTypeWeekOverride | undefined,
  effectiveWeeklyLimit: number | null,
  activeBookingCount: number,
): Pick<SessionTypeWeekCapacityDecision, 'overrideMode' | 'effectiveWeeklyLimit' | 'activeBookingCount' | 'allowsMoreBookings' | 'branchTaken' | 'denyReason' | 'overrideWeeklyLimit'> {
  if (override?.mode === 'FORCE_CLOSED') {
    return {
      overrideMode: 'FORCE_CLOSED',
      overrideWeeklyLimit: override.override_weekly_booking_limit,
      effectiveWeeklyLimit,
      activeBookingCount,
      allowsMoreBookings: false,
      branchTaken: 'deny_session_type_week_force_closed',
      denyReason: 'session_type_week_force_closed',
    };
  }

  if (override?.mode === 'FORCE_OPEN') {
    return {
      overrideMode: 'FORCE_OPEN',
      overrideWeeklyLimit: override.override_weekly_booking_limit,
      effectiveWeeklyLimit,
      activeBookingCount,
      allowsMoreBookings: true,
      branchTaken: 'allow_session_type_week_force_open',
      denyReason: null,
    };
  }

  if (effectiveWeeklyLimit == null) {
    return {
      overrideMode: override?.mode ?? 'AUTO',
      overrideWeeklyLimit: override?.override_weekly_booking_limit ?? null,
      effectiveWeeklyLimit,
      activeBookingCount,
      allowsMoreBookings: true,
      branchTaken: 'allow_session_type_week_without_limit',
      denyReason: null,
    };
  }

  const allowsMoreBookings = activeBookingCount < effectiveWeeklyLimit;
  return {
    overrideMode: override?.mode ?? 'AUTO',
    overrideWeeklyLimit: override?.override_weekly_booking_limit ?? null,
    effectiveWeeklyLimit,
    activeBookingCount,
    allowsMoreBookings,
    branchTaken: allowsMoreBookings
      ? 'allow_session_type_week_under_limit'
      : 'deny_session_type_week_limit_reached',
    denyReason: allowsMoreBookings ? null : 'session_type_week_limit_reached',
  };
}

export async function evaluateSessionTypeWeekCapacity(
  repository: Pick<IRepository, 'countActiveSessionTypeBookingsInRange' | 'listSessionTypeWeekOverrides'>,
  sessionType: SessionTypeRecord,
  slotStartIso: string,
  timezone: string,
  options?: { excludeBookingId?: string | null },
): Promise<SessionTypeWeekCapacityDecision> {
  const weekRange = localWeekRangeForSlot(slotStartIso, timezone);
  const overrides = await repository.listSessionTypeWeekOverrides(
    sessionType.id,
    weekRange.weekStartDate,
    weekRange.weekStartDate,
  );
  const override = overrides[0];
  const effectiveWeeklyLimit = override?.override_weekly_booking_limit ?? sessionType.weekly_booking_limit;
  const shouldCount = override?.mode !== 'FORCE_CLOSED';
  const activeBookingCount = shouldCount
    ? await repository.countActiveSessionTypeBookingsInRange(
      sessionType.id,
      weekRange.startInclusiveIso,
      weekRange.endExclusiveIso,
      options,
    )
    : 0;

  const decision = decisionForOverride(override, effectiveWeeklyLimit, activeBookingCount);
  return {
    weekStartDate: weekRange.weekStartDate,
    weekEndExclusiveDate: weekRange.weekEndExclusiveDate,
    weekStartInclusiveIso: weekRange.startInclusiveIso,
    weekEndExclusiveIso: weekRange.endExclusiveIso,
    ...decision,
  };
}

export async function assertSessionTypeWeekCapacityAvailable(
  repository: Pick<IRepository, 'countActiveSessionTypeBookingsInRange' | 'listSessionTypeWeekOverrides'>,
  sessionType: SessionTypeRecord,
  slotStartIso: string,
  timezone: string,
  logger?: Logger,
  options?: { excludeBookingId?: string | null },
): Promise<SessionTypeWeekCapacityDecision> {
  const startedDecision = localWeekRangeForSlot(slotStartIso, timezone);
  logger?.logInfo?.({
    source: 'backend',
    eventType: 'session_type_week_capacity_check_started',
    message: 'Checking session-type weekly capacity',
    context: {
      session_type_id: sessionType.id,
      session_type_slug: sessionType.slug,
      requested_slot_start: slotStartIso,
      availability_mode: sessionType.availability_mode,
      availability_timezone: timezone,
      weekly_booking_limit: sessionType.weekly_booking_limit,
      week_start_date: startedDecision.weekStartDate,
      week_end_exclusive_date: startedDecision.weekEndExclusiveDate,
      exclude_booking_id: options?.excludeBookingId ?? null,
      branch_taken: 'load_session_type_week_capacity_state',
      deny_reason: null,
    },
  });

  const decision = await evaluateSessionTypeWeekCapacity(repository, sessionType, slotStartIso, timezone, options);
  const logMethod = decision.allowsMoreBookings ? logger?.logInfo : logger?.logWarn;
  logMethod?.call(logger, {
    source: 'backend',
    eventType: 'session_type_week_capacity_check_completed',
    message: 'Completed session-type weekly capacity check',
    context: {
      session_type_id: sessionType.id,
      session_type_slug: sessionType.slug,
      requested_slot_start: slotStartIso,
      availability_mode: sessionType.availability_mode,
      availability_timezone: timezone,
      weekly_booking_limit: sessionType.weekly_booking_limit,
      override_mode: decision.overrideMode,
      override_weekly_limit: decision.overrideWeeklyLimit,
      effective_weekly_limit: decision.effectiveWeeklyLimit,
      active_booking_count: decision.activeBookingCount,
      week_start_date: decision.weekStartDate,
      week_end_exclusive_date: decision.weekEndExclusiveDate,
      branch_taken: decision.branchTaken,
      deny_reason: decision.denyReason,
    },
  });

  if (!decision.allowsMoreBookings) {
    if (decision.overrideMode === 'FORCE_CLOSED') {
      throw new ApiError(409, 'SESSION_TYPE_WEEK_FORCE_CLOSED', 'This offer is closed for the selected week.');
    }
    throw new ApiError(409, 'SESSION_TYPE_WEEK_CAP_REACHED', 'This offer has reached its weekly booking limit for the selected week.');
  }

  return decision;
}

export async function listAvailableSessionTypeSlots(
  repository: Pick<
    IRepository,
    | 'getPublicSessionTypes'
    | 'listSessionTypeAvailabilityWindows'
    | 'listSessionTypeWeekOverrides'
    | 'countActiveSessionTypeBookingsInRange'
  >,
  input: {
    from: string;
    to: string;
    kind: 'intro' | 'session';
    requestedTimezone: string;
    fallbackTimezone: string;
    offerSlug?: string | null;
    sessionTypeId?: string | null;
    busyTimes: TimeSlot[];
    heldSlots: TimeSlot[];
    slotLeadTimeHours: number;
    nowMs?: number;
  },
): Promise<{ sessionType: SessionTypeRecord; timezone: string; slots: Array<{ type: 'intro' | 'session'; start: string; end: string }> }> {
  const sessionType = await resolvePublicSessionTypeForBooking(repository, {
    kind: input.kind,
    offerSlug: input.offerSlug,
    sessionTypeId: input.sessionTypeId,
  });
  const details = await loadSessionTypeAvailabilityDetails(repository, sessionType, input.fallbackTimezone || input.requestedTimezone);
  const firstWeek = localWeekRangeForSlot(localDateTimeToIso(input.from, 12, 0, details.timezone), details.timezone).weekStartDate;
  const lastWeek = localWeekRangeForSlot(localDateTimeToIso(input.to, 12, 0, details.timezone), details.timezone).weekStartDate;
  const overridesByWeek = await loadWeekOverridesMap(repository, sessionType.id, firstWeek, lastWeek);
  const allBusy = [...input.busyTimes, ...input.heldSlots];
  const decisionCache = new Map<string, SessionTypeWeekCapacityDecision>();
  const slots: Array<{ type: 'intro' | 'session'; start: string; end: string }> = [];
  const nowMs = input.nowMs ?? Date.now();

  for (let date = input.from; date <= input.to; date = shiftIsoDate(date, 1)) {
    const candidates = details.mode === 'dedicated'
      ? getDedicatedCandidates(date, sessionType, details)
      : getSharedDefaultCandidates(date, input.kind, details.timezone);

    for (const candidate of candidates) {
      if (!passesLeadTime(candidate, input.slotLeadTimeHours, nowMs)) continue;
      if (overlapsBusyTime(candidate, allBusy)) continue;

      const weekRange = localWeekRangeForSlot(candidate.start, details.timezone);
      let decision = decisionCache.get(weekRange.weekStartDate);
      if (!decision) {
        const override = overridesByWeek.get(weekRange.weekStartDate);
        const effectiveWeeklyLimit = override?.override_weekly_booking_limit ?? sessionType.weekly_booking_limit;
        const shouldCount = override?.mode !== 'FORCE_CLOSED' && effectiveWeeklyLimit != null;
        const activeBookingCount = shouldCount
          ? await repository.countActiveSessionTypeBookingsInRange(
            sessionType.id,
            weekRange.startInclusiveIso,
            weekRange.endExclusiveIso,
          )
          : 0;
        const capacityDecision = decisionForOverride(override, effectiveWeeklyLimit, activeBookingCount);
        decision = {
          weekStartDate: weekRange.weekStartDate,
          weekEndExclusiveDate: weekRange.weekEndExclusiveDate,
          weekStartInclusiveIso: weekRange.startInclusiveIso,
          weekEndExclusiveIso: weekRange.endExclusiveIso,
          ...capacityDecision,
        };
        decisionCache.set(weekRange.weekStartDate, decision);
      }

      if (!decision.allowsMoreBookings) continue;
      slots.push({
        type: input.kind,
        start: candidate.start,
        end: candidate.end,
      });
    }
  }

  slots.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return {
    sessionType,
    timezone: details.timezone,
    slots,
  };
}

export async function buildSessionTypeAvailabilityWeekSummaries(
  repository: Pick<IRepository, 'countActiveSessionTypeBookingsInRange' | 'listSessionTypeWeekOverrides'>,
  sessionType: SessionTypeRecord,
  timezone: string,
  weekCount: number,
  nowIso = new Date().toISOString(),
): Promise<SessionTypeAvailabilityWeekSummary[]> {
  const currentWeekStart = localWeekRangeForSlot(nowIso, timezone).weekStartDate;
  const lastWeekStart = shiftIsoDate(currentWeekStart, (weekCount - 1) * 7);
  const overridesByWeek = await loadWeekOverridesMap(repository, sessionType.id, currentWeekStart, lastWeekStart);
  const summaries: SessionTypeAvailabilityWeekSummary[] = [];

  for (let index = 0; index < weekCount; index += 1) {
    const weekStartDate = shiftIsoDate(currentWeekStart, index * 7);
    const weekRange = localWeekRangeForSlot(localDateTimeToIso(weekStartDate, 12, 0, timezone), timezone);
    const override = overridesByWeek.get(weekStartDate);
    const effectiveWeeklyLimit = override?.override_weekly_booking_limit ?? sessionType.weekly_booking_limit;
    const shouldCount = override?.mode !== 'FORCE_CLOSED';
    const activeBookingCount = shouldCount
      ? await repository.countActiveSessionTypeBookingsInRange(
        sessionType.id,
        weekRange.startInclusiveIso,
        weekRange.endExclusiveIso,
      )
      : 0;
    const decision = decisionForOverride(override, effectiveWeeklyLimit, activeBookingCount);
    summaries.push({
      weekStartDate: weekRange.weekStartDate,
      weekEndExclusiveDate: weekRange.weekEndExclusiveDate,
      weekStartInclusiveIso: weekRange.startInclusiveIso,
      weekEndExclusiveIso: weekRange.endExclusiveIso,
      ...decision,
      remainingCapacity: decision.effectiveWeeklyLimit == null
        ? null
        : Math.max(decision.effectiveWeeklyLimit - decision.activeBookingCount, 0),
      note: override?.note ?? null,
      updatedBy: override?.updated_by ?? null,
    });
  }

  return summaries;
}
