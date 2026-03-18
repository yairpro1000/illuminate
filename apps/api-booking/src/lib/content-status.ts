import type {
  EventMarketingContent,
  EventStatus,
  EventUpdate,
  SessionTypeStatus,
  SessionTypeUpdate,
} from '../types.js';

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

export function normalizeEventRow<T extends { status: unknown }>(
  event: T,
): Omit<T, 'status'> & { status: EventStatus } {
  return {
    ...event,
    status: normalizeEventStatus(event.status),
    ...('marketing_content' in event
      ? { marketing_content: normalizeEventMarketingContent((event as T & { marketing_content?: unknown }).marketing_content) }
      : {}),
  };
}

export function normalizeSessionTypeRow<T extends { status: unknown }>(
  sessionType: T,
): Omit<T, 'status'> & { status: SessionTypeStatus } {
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
  const normalizedUpdates: Record<string, unknown> = { ...updates };
  if ('marketing_content' in updates) {
    normalizedUpdates.marketing_content = normalizeEventMarketingContent(updates.marketing_content) ?? {};
  }
  if (!('status' in updates) || updates.status == null) return normalizedUpdates;
  return {
    ...normalizedUpdates,
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

function normalizeEventMarketingList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function normalizeEventMarketingContent(value: unknown): EventMarketingContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const subtitle = typeof input.subtitle === 'string' ? input.subtitle.trim() : '';
  const intro = typeof input.intro === 'string' ? input.intro.trim() : '';
  const whatToExpect = normalizeEventMarketingList(input.what_to_expect);
  const takeaways = normalizeEventMarketingList(input.takeaways);

  if (!subtitle && !intro && !whatToExpect && !takeaways) return null;

  return {
    ...(subtitle ? { subtitle } : {}),
    ...(intro ? { intro } : {}),
    ...(whatToExpect ? { what_to_expect: whatToExpect } : {}),
    ...(takeaways ? { takeaways } : {}),
  };
}
