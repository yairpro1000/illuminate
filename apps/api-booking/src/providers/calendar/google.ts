import type { ICalendarProvider, CalendarEvent, CreateCalendarEventOptions } from './interface.js';
import type { TimeSlot } from '../../types.js';
import type { Logger } from '../../lib/observability.js';
import { instrumentFetch } from '../../../../shared/observability/backend.js';

interface GoogleEnv {
  GOOGLE_CLIENT_CALENDAR: string;
  GOOGLE_CLIENT_SECRET_CALENDAR: string;
  GOOGLE_REFRESH_TOKEN_CALENDAR: string;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_TOKEN_URI: string;
  GOOGLE_CALENDAR_ID: string;
}

interface ParsedGoogleApiError {
  code: number | null;
  status: string | null;
  message: string | null;
  reason: string | null;
}

// ── In-memory freeBusy cache (60 s TTL) ───────────────────────────────────────

const freeBusyCache = new Map<string, { data: TimeSlot[]; expires: number }>();
const MAX_FREEBUSY_CHUNK_DAYS = 90;

function normalizeCalendarId(raw: string | null | undefined): { value: string; wasTrimmed: boolean } {
  const original = String(raw ?? '');
  const trimmed = original.trim();
  return {
    value: trimmed,
    wasTrimmed: trimmed !== original,
  };
}

function parseGoogleApiError(body: string): ParsedGoogleApiError {
  try {
    const parsed = JSON.parse(body) as {
      error?: string | {
        code?: unknown;
        status?: unknown;
        message?: unknown;
        errors?: Array<{ reason?: unknown }>;
      };
      error_description?: unknown;
    };
    if (typeof parsed.error === 'string') {
      return {
        code: null,
        status: null,
        message: typeof parsed.error_description === 'string' ? parsed.error_description : null,
        reason: parsed.error,
      };
    }
    const error = parsed.error;
    if (!error || typeof error !== 'object') {
      return { code: null, status: null, message: null, reason: null };
    }
    const firstReason = Array.isArray(error.errors) && error.errors.length > 0
      ? error.errors[0]?.reason
      : null;
    return {
      code: typeof error.code === 'number' ? error.code : null,
      status: typeof error.status === 'string' ? error.status : null,
      message: typeof error.message === 'string' ? error.message : null,
      reason: typeof firstReason === 'string' ? firstReason : null,
    };
  } catch {
    return { code: null, status: null, message: null, reason: null };
  }
}

interface GoogleCalendarDiagnostics {
  calendarOperation: 'free_busy' | 'create_event' | 'update_event' | 'delete_event';
  bookingId?: string | null;
  requestId?: string | null;
}

function sanitizeGoogleBodyForError(errorBody: string): string {
  return errorBody.slice(0, 4_000);
}

function stringifyUnknownPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function b64url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function createServiceAccountJWT(env: GoogleEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header64  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload64 = b64url(JSON.stringify({
    iss:   env.GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud:   env.GOOGLE_TOKEN_URI,
    iat:   now,
    exp:   now + 3600,
  }));
  const signingInput = `${header64}.${payload64}`;

  const pemBody = env.GOOGLE_PRIVATE_KEY
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const derBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    derBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  const sig64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${signingInput}.${sig64}`;
}

async function getServiceAccountAccessToken(env: GoogleEnv, logger?: Logger): Promise<string> {
  const jwt = await createServiceAccountJWT(env);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  const res = logger
    ? await instrumentFetch(logger, {
        provider: 'google_calendar',
        operation: 'service_account_token_exchange',
        method: 'POST',
        url: env.GOOGLE_TOKEN_URI,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
    : await fetch(env.GOOGLE_TOKEN_URI, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

  if (!res.ok) {
    const errorBody = await res.text();
    const parsedError = parseGoogleApiError(errorBody);
    logger?.logError?.({
      source: 'backend',
      eventType: 'google_calendar_service_account_token_exchange_failed',
      message: 'Google service-account token exchange failed for freeBusy read',
      context: {
        google_http_status: res.status,
        google_error_code: parsedError.code,
        google_error_status: parsedError.status,
        google_error_reason: parsedError.reason,
        google_error_message: parsedError.message,
        google_response_body: sanitizeGoogleBodyForError(errorBody),
        branch_taken: 'abort_free_busy_service_account_token_exchange_failed',
        deny_reason: parsedError.reason ?? parsedError.message ?? `google_service_account_token_exchange_http_${res.status}`,
      },
    });
    throw new Error(`Google service-account token exchange failed (${res.status}): ${errorBody}`);
  }

  const data = await res.json() as { access_token?: unknown };
  if (typeof data.access_token !== 'string' || !data.access_token) {
    logger?.logError?.({
      source: 'backend',
      eventType: 'google_calendar_service_account_token_exchange_failed',
      message: 'Google service-account token exchange response missing access_token',
      context: {
        google_http_status: res.status,
        google_response_body: sanitizeGoogleBodyForError(stringifyUnknownPayload(data)),
        branch_taken: 'abort_free_busy_service_account_token_exchange_missing_access_token',
        deny_reason: 'service_account_token_exchange_missing_access_token',
      },
    });
    throw new Error('Google service-account token exchange failed (missing_access_token)');
  }
  return data.access_token;
}

async function getGoogleAccessToken(
  env: GoogleEnv,
  logger?: Logger,
  diagnostics?: GoogleCalendarDiagnostics,
): Promise<string> {
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const bookingId = diagnostics?.bookingId ?? null;
  const requestId = diagnostics?.requestId ?? null;
  const calendarOperation = diagnostics?.calendarOperation ?? 'create_event';

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_CALENDAR,
    client_secret: env.GOOGLE_CLIENT_SECRET_CALENDAR,
    refresh_token: env.GOOGLE_REFRESH_TOKEN_CALENDAR,
    grant_type: 'refresh_token',
  });

  logger?.logInfo?.({
    source: 'backend',
    eventType: 'google_calendar_token_exchange_started',
    message: 'Starting Google OAuth refresh-token exchange',
    context: {
      calendar_operation: calendarOperation,
      booking_id: bookingId,
      request_id: requestId,
      branch_taken: 'exchange_refresh_token_for_access_token',
      deny_reason: null,
    },
  });

  let res: Response;
  try {
    res = logger
      ? await instrumentFetch(logger, {
          provider: 'google_calendar',
          operation: 'token_exchange',
          method: 'POST',
          url: tokenUrl,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        })
      : await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
  } catch (error) {
    logger?.logError?.({
      source: 'backend',
      eventType: 'google_calendar_token_exchange_failed',
      message: 'Google OAuth token exchange request failed before receiving a response',
      context: {
        calendar_operation: calendarOperation,
        booking_id: bookingId,
        request_id: requestId,
        google_http_status: null,
        google_error_reason: 'token_exchange_request_failed',
        google_error_message: error instanceof Error ? error.message : String(error),
        google_response_body: null,
        branch_taken: 'abort_calendar_write_token_exchange_request_failed',
        deny_reason: 'token_exchange_request_failed',
      },
    });
    throw new Error('Google token exchange failed (request_error)');
  }

  if (!res.ok) {
    const errorBody = await res.text();
    const parsedError = parseGoogleApiError(errorBody);
    logger?.logError?.({
      source: 'backend',
      eventType: 'google_calendar_token_exchange_failed',
      message: 'Google OAuth token exchange failed',
      context: {
        calendar_operation: calendarOperation,
        booking_id: bookingId,
        request_id: requestId,
        google_http_status: res.status,
        google_error_code: parsedError.code,
        google_error_status: parsedError.status,
        google_error_reason: parsedError.reason,
        google_error_message: parsedError.message,
        google_response_body: sanitizeGoogleBodyForError(errorBody),
        branch_taken: 'abort_calendar_write_token_exchange_failed',
        deny_reason: parsedError.reason ?? parsedError.message ?? `google_token_exchange_http_${res.status}`,
      },
    });
    throw new Error(`Google token exchange failed (${res.status}): ${errorBody}`);
  }

  const data = await res.json() as { access_token?: unknown };
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  if (!accessToken) {
    logger?.logError?.({
      source: 'backend',
      eventType: 'google_calendar_token_exchange_failed',
      message: 'Google OAuth token exchange response missing access_token',
      context: {
        calendar_operation: calendarOperation,
        booking_id: bookingId,
        request_id: requestId,
        google_http_status: res.status,
        google_error_reason: 'token_exchange_missing_access_token',
        google_error_message: null,
        google_response_body: sanitizeGoogleBodyForError(stringifyUnknownPayload(data)),
        branch_taken: 'abort_calendar_write_token_exchange_missing_access_token',
        deny_reason: 'token_exchange_missing_access_token',
      },
    });
    throw new Error('Google token exchange failed (missing_access_token)');
  }

  logger?.logInfo?.({
    source: 'backend',
    eventType: 'google_calendar_token_exchange_succeeded',
    message: 'Google OAuth token exchange succeeded',
    context: {
      calendar_operation: calendarOperation,
      booking_id: bookingId,
      request_id: requestId,
      branch_taken: 'token_exchange_succeeded',
      deny_reason: null,
    },
  });

  return accessToken;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class GoogleCalendarProvider implements ICalendarProvider {
  private readonly calendarId: string;
  private readonly calendarIdWasTrimmed: boolean;

  constructor(private env: GoogleEnv, private logger?: Logger) {
    const normalized = normalizeCalendarId(env.GOOGLE_CALENDAR_ID);
    this.calendarId = normalized.value;
    this.calendarIdWasTrimmed = normalized.wasTrimmed;
  }

  async getBusyTimes(from: string, to: string): Promise<TimeSlot[]> {
    const cacheKey = `${this.calendarId}:${from}:${to}`;
    const cached   = freeBusyCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }

    const token = await getServiceAccountAccessToken(this.env, this.logger);
    const chunks = splitDateRangeIntoChunks(from, to, MAX_FREEBUSY_CHUNK_DAYS);
    const busy: TimeSlot[] = [];
    const seen = new Set<string>();

    for (const chunk of chunks) {
      const chunkBusy = await this.fetchFreeBusyChunk(token, chunk.from, chunk.to);
      for (const slot of chunkBusy) {
        const key = `${slot.start}|${slot.end}`;
        if (!seen.has(key)) {
          seen.add(key);
          busy.push(slot);
        }
      }
    }

    busy.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    freeBusyCache.set(cacheKey, { data: busy, expires: Date.now() + 60_000 });
    return busy;
  }

  private async fetchFreeBusyChunk(token: string, from: string, to: string): Promise<TimeSlot[]> {
    if (!this.calendarId) {
      throw new Error('GOOGLE_CALENDAR_ID is empty after trim');
    }

    const payload = {
      timeMin: `${from}T00:00:00Z`,
      timeMax: `${to}T23:59:59Z`,
      items:   [{ id: this.calendarId }],
    };

    const body = JSON.stringify(payload);
    const res = this.logger
      ? await instrumentFetch(this.logger, {
          provider: 'google_calendar',
          operation: 'free_busy',
          method: 'POST',
          url: 'https://www.googleapis.com/calendar/v3/freeBusy',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
        })
      : await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
        });

    if (!res.ok) {
      const body = await res.text();
      console.error('Google Calendar error', {
        stage: 'freeBusy',
        status: res.status,
        from,
        to,
        body: body.slice(0, 500),
      });
      throw new Error(`Google freeBusy failed (${res.status})`);
    }

    const data = await res.json() as {
      calendars: Record<string, { busy: Array<{ start: string; end: string }> }>;
    };

    return data.calendars[this.calendarId]?.busy ?? [];
  }

  async createEvent(event: CalendarEvent, options?: CreateCalendarEventOptions): Promise<{ eventId: string }> {
    if (!this.calendarId) {
      throw new Error('GOOGLE_CALENDAR_ID is empty after trim');
    }

    const diagnostics = toGoogleDiagnosticsContext(event);

    this.logger?.logInfo?.({
      source: 'backend',
      eventType: 'google_calendar_insert_request',
      message: 'Preparing Google Calendar events.insert request',
      context: {
        booking_id: diagnostics.bookingId,
        request_id: diagnostics.requestId,
        calendar_id_present: this.calendarId.length > 0,
        calendar_id_was_trimmed: this.calendarIdWasTrimmed,
        calendar_id_shape: this.calendarId.includes('@') ? 'email_like' : 'opaque_id_like',
        has_event_id_hint: Boolean(options?.eventIdHint),
        branch_taken: 'call_google_events_insert',
        deny_reason: null,
      },
    });

    const token = await getGoogleAccessToken(this.env, this.logger, {
      calendarOperation: 'create_event',
      bookingId: diagnostics.bookingId,
      requestId: diagnostics.requestId,
    });
    const calId = encodeURIComponent(this.calendarId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?sendUpdates=all`;
    const initialBody = JSON.stringify(
      buildGoogleEventBody(event, {
        eventIdHint: options?.eventIdHint ?? null,
      }),
    );
    const initialRes = await this.postCalendarEvent(url, token, initialBody);

    if (initialRes.ok) {
      const data = await initialRes.json() as { id: string };
      return { eventId: data.id };
    }

    if (initialRes.status === 409 && options?.eventIdHint) {
      await this.updateEvent(options.eventIdHint, event);
      return { eventId: options.eventIdHint };
    }

    const initialErrorBody = await initialRes.text();
    const initialGoogleError = parseGoogleApiError(initialErrorBody);

    this.logGoogleInsertFailure({
      status: initialRes.status,
      googleError: initialGoogleError,
      googleResponseBody: initialErrorBody,
      hasEventIdHint: Boolean(options?.eventIdHint),
      bookingId: diagnostics.bookingId,
      requestId: diagnostics.requestId,
      branchTaken: 'google_events_insert_failed',
    });
    throw new Error(`Google createEvent failed (${initialRes.status}): ${initialErrorBody}`);
  }

  async updateEvent(eventId: string, event: CalendarEvent): Promise<void> {
    if (!this.calendarId) {
      throw new Error('GOOGLE_CALENDAR_ID is empty after trim');
    }
    const diagnostics = toGoogleDiagnosticsContext(event);
    const token = await getGoogleAccessToken(this.env, this.logger, {
      calendarOperation: 'update_event',
      bookingId: diagnostics.bookingId,
      requestId: diagnostics.requestId,
    });
    const calId = encodeURIComponent(this.calendarId);
    const evId  = encodeURIComponent(eventId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${evId}?sendUpdates=all`;
    const initialBody = JSON.stringify(
      buildGoogleEventBody(event, {
        eventIdHint: null,
      }),
    );
    const initialRes = await this.putCalendarEvent(url, token, initialBody);
    if (initialRes.ok) return;

    const initialErrorBody = await initialRes.text();
    const initialGoogleError = parseGoogleApiError(initialErrorBody);
    this.logger?.logError?.({
      source: 'backend',
      eventType: 'google_calendar_update_failed',
      message: 'Google Calendar events.update failed',
      context: {
        booking_id: diagnostics.bookingId,
        request_id: diagnostics.requestId,
        google_event_id: eventId,
        google_http_status: initialRes.status,
        google_error_code: initialGoogleError.code,
        google_error_status: initialGoogleError.status,
        google_error_reason: initialGoogleError.reason,
        google_error_message: initialGoogleError.message,
        google_response_body: sanitizeGoogleBodyForError(initialErrorBody),
        branch_taken: 'google_events_update_failed',
        deny_reason: initialGoogleError.reason ?? initialGoogleError.message ?? `google_events_update_http_${initialRes.status}`,
      },
    });

    throw new Error(`Google updateEvent failed (${initialRes.status}): ${initialErrorBody}`);
  }

  async deleteEvent(eventId: string): Promise<void> {
    if (!this.calendarId) {
      throw new Error('GOOGLE_CALENDAR_ID is empty after trim');
    }
    const token = await getGoogleAccessToken(this.env, this.logger, {
      calendarOperation: 'delete_event',
    });
    const calId = encodeURIComponent(this.calendarId);
    const evId  = encodeURIComponent(eventId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${evId}?sendUpdates=all`;
    const res = this.logger
      ? await instrumentFetch(this.logger, {
          provider: 'google_calendar',
          operation: 'delete_event',
          method: 'DELETE',
          url,
          headers: { 'Authorization': `Bearer ${token}` },
        })
      : await fetch(url, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        });

    // 404 / 410 = already gone — treat as success (idempotent)
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      const body = await res.text();
      const parsedError = parseGoogleApiError(body);
      this.logger?.logError?.({
        source: 'backend',
        eventType: 'google_calendar_delete_failed',
        message: 'Google Calendar events.delete failed',
        context: {
          google_event_id: eventId,
          google_http_status: res.status,
          google_error_code: parsedError.code,
          google_error_status: parsedError.status,
          google_error_reason: parsedError.reason,
          google_error_message: parsedError.message,
          google_response_body: sanitizeGoogleBodyForError(body),
          branch_taken: 'google_events_delete_failed',
          deny_reason: parsedError.reason ?? parsedError.message ?? `google_events_delete_http_${res.status}`,
        },
      });
      throw new Error(`Google deleteEvent failed (${res.status}): ${body}`);
    }
  }

  private async postCalendarEvent(url: string, token: string, body: string): Promise<Response> {
    if (this.logger) {
      return instrumentFetch(this.logger, {
        provider: 'google_calendar',
        operation: 'create_event',
        method: 'POST',
        url,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    }
    return fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  }

  private async putCalendarEvent(url: string, token: string, body: string): Promise<Response> {
    if (this.logger) {
      return instrumentFetch(this.logger, {
        provider: 'google_calendar',
        operation: 'update_event',
        method: 'PUT',
        url,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    }
    return fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  }

  private logGoogleInsertFailure(input: {
    status: number;
    googleError: ParsedGoogleApiError;
    googleResponseBody: string;
    hasEventIdHint: boolean;
    bookingId: string | null;
    requestId: string | null;
    branchTaken: string;
  }): void {
    this.logger?.logError?.({
      source: 'backend',
      eventType: 'google_calendar_insert_failed',
      message: 'Google Calendar events.insert failed',
      context: {
        booking_id: input.bookingId,
        request_id: input.requestId,
        calendar_id_was_trimmed: this.calendarIdWasTrimmed,
        calendar_id_shape: this.calendarId.includes('@') ? 'email_like' : 'opaque_id_like',
        has_event_id_hint: input.hasEventIdHint,
        google_http_status: input.status,
        google_error_code: input.googleError.code,
        google_error_status: input.googleError.status,
        google_error_reason: input.googleError.reason,
        google_error_message: input.googleError.message,
        google_response_body: sanitizeGoogleBodyForError(input.googleResponseBody),
        branch_taken: input.branchTaken,
        deny_reason: input.googleError.reason ?? input.googleError.message ?? `google_events_insert_http_${input.status}`,
      },
    });
  }
}

function buildGoogleEventBody(
  event: CalendarEvent,
  options: { eventIdHint: string | null },
): Record<string, unknown> {
  return {
    ...(options.eventIdHint ? { id: options.eventIdHint } : {}),
    summary: event.title,
    description: event.description,
    location: event.location,
    start: { dateTime: event.startIso, timeZone: event.timezone },
    end: { dateTime: event.endIso, timeZone: event.timezone },
    attendees: [{ email: event.attendeeEmail, displayName: event.attendeeName }],
    ...(event.privateMetadata ? { extendedProperties: { private: event.privateMetadata } } : {}),
  };
}

function toGoogleDiagnosticsContext(event: CalendarEvent): { bookingId: string | null; requestId: string | null } {
  const bookingId = typeof event.privateMetadata?.booking_id === 'string'
    ? event.privateMetadata.booking_id
    : null;
  const requestId = typeof event.privateMetadata?.request_id === 'string'
    ? event.privateMetadata.request_id
    : null;
  return { bookingId, requestId };
}

function splitDateRangeIntoChunks(
  from: string,
  to: string,
  maxChunkDays: number,
): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  const end = new Date(`${to}T00:00:00Z`);
  let cursor = new Date(`${from}T00:00:00Z`);

  while (cursor <= end) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + (maxChunkDays - 1));
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    chunks.push({
      from: chunkStart.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10),
    });

    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return chunks;
}
