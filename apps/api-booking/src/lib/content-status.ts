import type { Event, EventStatus, EventUpdate, SessionTypeRecord, SessionTypeStatus, SessionTypeUpdate } from '../types.js';

function trimStatus(value: unknown): string {
  return String(value ?? '').trim();
}

export function normalizeEventStatus(value: unknown): EventStatus {
  const raw = trimStatus(value);
  const upper = raw.toUpperCase();
  switch (upper) {
    case 'DRAFT':
      return 'draft';
    case 'PUBLISHED':
      return 'published';
    case 'CANCELED':
    case 'CANCELLED':
      return 'cancelled';
    case 'SOLD_OUT':
      return 'sold_out';
    default:
      return raw.toLowerCase().replace(/^canceled$/, 'cancelled') as EventStatus;
  }
}

export function normalizeSessionTypeStatus(value: unknown): SessionTypeStatus {
  const raw = trimStatus(value);
  const upper = raw.toUpperCase();
  switch (upper) {
    case 'DRAFT':
      return 'draft';
    case 'ACTIVE':
      return 'active';
    case 'HIDDEN':
      return 'hidden';
    default:
      return raw.toLowerCase() as SessionTypeStatus;
  }
}

export function isEventPublished(value: unknown): boolean {
  return normalizeEventStatus(value) === 'published';
}

export function isEventPubliclyListed(value: unknown): boolean {
  const status = normalizeEventStatus(value);
  return status === 'published' || status === 'sold_out';
}

export function normalizeEventRow<T extends Pick<Event, 'status'>>(event: T): T {
  return {
    ...event,
    status: normalizeEventStatus(event.status),
  };
}

export function normalizeSessionTypeRow<T extends Pick<SessionTypeRecord, 'status'>>(sessionType: T): T {
  return {
    ...sessionType,
    status: normalizeSessionTypeStatus(sessionType.status),
  };
}

export function toDbEventStatus(value: unknown): string {
  switch (normalizeEventStatus(value)) {
    case 'draft':
      return 'DRAFT';
    case 'published':
      return 'PUBLISHED';
    case 'cancelled':
      return 'CANCELED';
    case 'sold_out':
      return 'SOLD_OUT';
    default:
      return trimStatus(value).toUpperCase();
  }
}

export function toDbSessionTypeStatus(value: unknown): string {
  switch (normalizeSessionTypeStatus(value)) {
    case 'draft':
      return 'DRAFT';
    case 'active':
      return 'ACTIVE';
    case 'hidden':
      return 'HIDDEN';
    default:
      return trimStatus(value).toUpperCase();
  }
}

export function normalizeEventUpdateForDb(updates: EventUpdate): Record<string, unknown> {
  if (!('status' in updates) || updates.status == null) return { ...updates };
  return {
    ...updates,
    status: toDbEventStatus(updates.status),
  };
}

export function normalizeSessionTypeUpdateForDb(updates: SessionTypeUpdate): Record<string, unknown> {
  if (!('status' in updates) || updates.status == null) return { ...updates };
  return {
    ...updates,
    status: toDbSessionTypeStatus(updates.status),
  };
}
