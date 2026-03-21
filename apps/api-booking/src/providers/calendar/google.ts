import type {
  ICalendarProvider,
  CalendarEvent,
  CalendarEventUpsertResult,
  CreateCalendarEventOptions,
} from './interface.js';
import { RetryableCalendarWriteError as RetryableCalendarWriteErrorClass } from './interface.js';
import type { TimeSlot } from '../../types.js';
import type { Logger } from '../../lib/logger.js';
import {
  resolveGoogleServiceAccountJsonConfig,
  type GoogleServiceAccountConfig,
} from '../../lib/google-service-account.js';
import { instrumentFetch } from '../../../../shared/observability/backend.js';

interface GoogleEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_CALENDAR_ID: string;
}

interface ParsedGoogleApiError {
  code: number | null;
  status: string | null;
  message: string | null;
  reason: string | null;
}

interface GoogleCalendarEventResponse {
  id: string;
  htmlLink?: string | null;
  status?: string | null;
  hangoutLink?: string | null;
  conferenceData?: {
    createRequest?: {
      status?: {
        statusCode?: string | null;
      } | null;
    } | null;
    entryPoints?: Array<{
      uri?: string | null;
      entryPointType?: string | null;
    }> | null;
  } | null;
}

interface GoogleCalendarListResponse {
  items?: GoogleCalendarEventResponse[] | null;
}

const GOOGLE_MEET_HYDRATION_RETRY_DELAYS_MS = [500, 1500, 3000] as const;

// ── In-memory freeBusy cache (60 s TTL) ───────────────────────────────────────

const freeBusyCache = new Map<string, { data: TimeSlot[]; expires: number }>();
const MAX_FREEBUSY_CHUNK_DAYS = 90;
const GOOGLE_CALENDAR_BURST_THROTTLE_MS = { min: 200, max: 800 } as const;
const RETRYABLE_WRITE_REASONS = new Set(['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded']);

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInteger(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

function isRetryableWriteFailure(status: number, parsedError: ParsedGoogleApiError): boolean {
  return (status === 403 || status === 429)
    && Boolean(parsedError.reason && RETRYABLE_WRITE_REASONS.has(parsedError.reason));
}

function b64url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function createServiceAccountJWT(serviceAccount: GoogleServiceAccountConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header64  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload64 = b64url(JSON.stringify({
    iss:   serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud:   serviceAccount.token_uri,
    iat:   now,
    exp:   now + 3600,
  }));
  const signingInput = `${header64}.${payload64}`;

  const pemBody = serviceAccount.private_key
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

async function getServiceAccountAccessToken(
  env: GoogleEnv,
  logger?: Logger,
  diagnostics?: GoogleCalendarDiagnostics,
): Promise<string> {
  const bookingId = diagnostics?.bookingId ?? null;
  const requestId = diagnostics?.requestId ?? null;
  const calendarOperation = diagnostics?.calendarOperation ?? 'free_busy';
  let serviceAccount: GoogleServiceAccountConfig;

  try {
    serviceAccount = resolveGoogleServiceAccountJsonConfig(env);
  } catch (error) {
    logger?.logError?.({
      source: 'backend',
      eventType: 'google_calendar_service_account_config_invalid',
      message: 'Google Calendar service-account configuration is missing or invalid',
      context: {
        auth_mode: 'service_account',
        auth_config_source: 'service_account_json',
        calendar_operation: calendarOperation,
        booking_id: bookingId,
        request_id: requestId,
        branch_taken: 'abort_calendar_operation_missing_service_account_json',
        deny_reason: error instanceof Error ? error.message : 'invalid_google_service_account_json',
      },
    });
    throw error;
  }

  logger?.logInfo?.({
    source: 'backend',
    eventType: 'google_calendar_service_account_token_exchange_started',
    message: 'Starting Google service-account token exchange',
    context: {
      auth_mode: 'service_account',
      auth_config_source: 'service_account_json',
      calendar_operation: calendarOperation,
      booking_id: bookingId,
      request_id: requestId,
      branch_taken: 'exchange_service_account_jwt_for_access_token',
      deny_reason: null,
    },
  });

  const jwt = await createServiceAccountJWT(serviceAccount);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  let res: Response;
  try {
    res = logger
      ? await instrumentFetch(logger, {
          provider: 'google_calendar',
          operation: 'service_account_token_exchange',
          method: 'POST',
          url: serviceAccount.token_uri,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        })
      : await fetch(serviceAccount.token_uri, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
  } catch (error) {
    logger?.logError?.({
      source: 'backend',
      eventType: 'google_calendar_service_account_token_exchange_failed',
      message: 'Google service-account token exchange request failed before receiving a response',
      context: {
        auth_mode: 'service_account',
        auth_config_source: 'service_account_json',
        calendar_operation: calendarOperation,
        booking_id: bookingId,
        request_id: requestId,
        google_http_status: null,
        google_error_reason: 'service_account_token_exchange_request_failed',
        google_error_message: error instanceof Error ? error.message : String(error),
        google_response_body: null,
        branch_taken: 'abort_calendar_operation_service_account_token_exchange_request_failed',
        deny_reason: 'service_account_token_exchange_request_failed',
      },
    });
    throw new Error('Google service-account token exchange failed (request_error)');
  }

  if (!res.ok) {
    const errorBody = await res.text();
    const parsedError = parseGoogleApiError(errorBody);
    logger?.logError?.({
      source: 'backend',
      eventType: 'google_calendar_service_account_token_exchange_failed',
      message: 'Google service-account token exchange failed',
      context: {
        auth_mode: 'service_account',
        auth_config_source: 'service_account_json',
        calendar_operation: calendarOperation,
        booking_id: bookingId,
        request_id: requestId,
        google_http_status: res.status,
        google_error_code: parsedError.code,
        google_error_status: parsedError.status,
        google_error_reason: parsedError.reason,
        google_error_message: parsedError.message,
        google_response_body: sanitizeGoogleBodyForError(errorBody),
        branch_taken: 'abort_calendar_operation_service_account_token_exchange_failed',
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
        auth_mode: 'service_account',
        auth_config_source: 'service_account_json',
        calendar_operation: calendarOperation,
        booking_id: bookingId,
        request_id: requestId,
        google_http_status: res.status,
        google_response_body: sanitizeGoogleBodyForError(stringifyUnknownPayload(data)),
        branch_taken: 'abort_calendar_operation_service_account_token_exchange_missing_access_token',
        deny_reason: 'service_account_token_exchange_missing_access_token',
      },
    });
    throw new Error('Google service-account token exchange failed (missing_access_token)');
  }

  logger?.logInfo?.({
    source: 'backend',
    eventType: 'google_calendar_service_account_token_exchange_succeeded',
    message: 'Google service-account token exchange succeeded',
    context: {
      auth_mode: 'service_account',
      auth_config_source: 'service_account_json',
      calendar_operation: calendarOperation,
      booking_id: bookingId,
      request_id: requestId,
      branch_taken: 'service_account_token_exchange_succeeded',
      deny_reason: null,
    },
  });
  return data.access_token;
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

    const token = await getServiceAccountAccessToken(this.env, this.logger, {
      calendarOperation: 'free_busy',
    });
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

  private async applyBurstThrottle(bookingId: string | null | undefined, requestId: string | null | undefined): Promise<void> {
    const delayMs = randomInteger(
      GOOGLE_CALENDAR_BURST_THROTTLE_MS.min,
      GOOGLE_CALENDAR_BURST_THROTTLE_MS.max,
    );
    this.logger?.logInfo?.({
      source: 'backend',
      eventType: 'google_calendar_insert_throttle_delay',
      message: 'Applied pre-insert burst throttle delay before Google Calendar write',
      context: {
        booking_id: bookingId ?? null,
        request_id: requestId ?? null,
        delay_ms: delayMs,
        branch_taken: 'apply_pre_insert_burst_throttle_delay',
        deny_reason: null,
      },
    });
    await sleep(delayMs);
  }

  private async findExistingEventByBookingId(
    token: string,
    bookingId: string,
    requestId: string | null | undefined,
  ): Promise<CalendarEventUpsertResult | null> {
    const calId = encodeURIComponent(this.calendarId);
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calId}/events`);
    url.searchParams.set('privateExtendedProperty', `booking_id=${bookingId}`);
    url.searchParams.set('maxResults', '1');
    url.searchParams.set('showDeleted', 'false');

    this.logger?.logInfo?.({
      source: 'backend',
      eventType: 'google_calendar_existing_event_lookup_started',
      message: 'Looking up existing Google Calendar event by booking id metadata',
      context: {
        booking_id: bookingId,
        request_id: requestId ?? null,
        branch_taken: 'lookup_existing_event_by_booking_id',
        deny_reason: null,
      },
    });

    const res = this.logger
      ? await instrumentFetch(this.logger, {
          provider: 'google_calendar',
          operation: 'lookup_event_by_booking_id',
          method: 'GET',
          url: url.toString(),
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        })
      : await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

    if (!res.ok) {
      const errorBody = await res.text();
      const parsedError = parseGoogleApiError(errorBody);
      this.logger?.logWarn?.({
        source: 'backend',
        eventType: 'google_calendar_existing_event_lookup_failed',
        message: 'Existing Google Calendar event lookup failed; proceeding to insert path',
        context: {
          booking_id: bookingId,
          request_id: requestId ?? null,
          google_http_status: res.status,
          google_error_reason: parsedError.reason,
          google_error_message: parsedError.message,
          branch_taken: 'proceed_without_existing_event_lookup_result',
          deny_reason: parsedError.reason ?? parsedError.message ?? `google_events_lookup_http_${res.status}`,
        },
      });
      return null;
    }

    const data = await res.json() as GoogleCalendarListResponse;
    const existing = (data.items ?? []).find((item) => item.id && item.status !== 'cancelled');

    this.logger?.logInfo?.({
      source: 'backend',
      eventType: 'google_calendar_existing_event_lookup_completed',
      message: 'Completed Google Calendar existing-event lookup',
      context: {
        booking_id: bookingId,
        request_id: requestId ?? null,
        has_existing_google_event: Boolean(existing),
        existing_google_event_id: existing?.id ?? null,
        branch_taken: existing
          ? 'existing_event_found_by_booking_id'
          : 'no_existing_event_found_by_booking_id',
        deny_reason: existing ? null : 'existing_event_not_found',
      },
    });

    return existing ? toCalendarUpsertResult(existing) : null;
  }

  private async hydrateConferenceDataIfMissing(
    token: string,
    data: GoogleCalendarEventResponse,
    input: {
      bookingId: string | null;
      requestId: string | null;
      operation: 'create_event' | 'update_event';
    },
  ): Promise<GoogleCalendarEventResponse> {
    if (extractGoogleMeetLink(data)) {
      return data;
    }

    this.logger?.logInfo?.({
      source: 'backend',
      eventType: 'google_calendar_meet_hydration_started',
      message: 'Google Calendar write response had no Meet link; fetching event to hydrate conference data',
      context: {
        booking_id: input.bookingId,
        request_id: input.requestId,
        google_event_id: data.id,
        calendar_operation: input.operation,
        conference_create_status: readConferenceCreateStatus(data),
        branch_taken: 'refetch_google_event_for_meet_link_hydration',
        deny_reason: 'google_meet_link_missing_in_initial_write_response',
      },
    });

    let hydrated = data;
    for (let attemptIndex = 0; attemptIndex <= GOOGLE_MEET_HYDRATION_RETRY_DELAYS_MS.length; attemptIndex += 1) {
      if (attemptIndex > 0) {
        await sleep(GOOGLE_MEET_HYDRATION_RETRY_DELAYS_MS[attemptIndex - 1] ?? 0);
      }

      const fetched = await this.fetchCalendarEventById(token, data.id, input);
      if (!fetched) {
        break;
      }

      hydrated = fetched;
      if (extractGoogleMeetLink(hydrated)) {
        this.logger?.logInfo?.({
          source: 'backend',
          eventType: 'google_calendar_meet_hydration_completed',
          message: 'Fetched Google Calendar event now contains Meet link data',
          context: {
            booking_id: input.bookingId,
            request_id: input.requestId,
            google_event_id: hydrated.id,
            calendar_operation: input.operation,
            hydration_attempt: attemptIndex + 1,
            conference_create_status: readConferenceCreateStatus(hydrated),
            branch_taken: 'google_event_hydrated_with_meet_link',
            deny_reason: null,
          },
        });
        return hydrated;
      }
    }

    this.logger?.logWarn?.({
      source: 'backend',
      eventType: 'google_calendar_meet_hydration_completed',
      message: 'Fetched Google Calendar event still has no Meet link data after hydration attempts',
      context: {
        booking_id: input.bookingId,
        request_id: input.requestId,
        google_event_id: hydrated.id,
        calendar_operation: input.operation,
        conference_create_status: readConferenceCreateStatus(hydrated),
        branch_taken: 'google_event_hydration_completed_without_meet_link',
        deny_reason: 'google_meet_link_missing_after_hydration_attempts',
      },
    });
    return hydrated;
  }

  private async fetchCalendarEventById(
    token: string,
    eventId: string,
    input: {
      bookingId: string | null;
      requestId: string | null;
      operation: 'create_event' | 'update_event';
    },
  ): Promise<GoogleCalendarEventResponse | null> {
    const calId = encodeURIComponent(this.calendarId);
    const evId = encodeURIComponent(eventId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${evId}?conferenceDataVersion=1`;

    const res = this.logger
      ? await instrumentFetch(this.logger, {
          provider: 'google_calendar',
          operation: 'hydrate_meet_link',
          method: 'GET',
          url,
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        })
      : await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

    if (!res.ok) {
      const errorBody = await res.text();
      const parsedError = parseGoogleApiError(errorBody);
      this.logger?.logWarn?.({
        source: 'backend',
        eventType: 'google_calendar_meet_hydration_fetch_failed',
        message: 'Failed to fetch Google Calendar event while hydrating Meet link data',
        context: {
          booking_id: input.bookingId,
          request_id: input.requestId,
          google_event_id: eventId,
          calendar_operation: input.operation,
          google_http_status: res.status,
          google_error_reason: parsedError.reason,
          google_error_message: parsedError.message,
          branch_taken: 'google_event_hydration_fetch_failed',
          deny_reason: parsedError.reason ?? parsedError.message ?? `google_event_get_http_${res.status}`,
        },
      });
      return null;
    }

    return await res.json() as GoogleCalendarEventResponse;
  }

  async createEvent(event: CalendarEvent, options?: CreateCalendarEventOptions): Promise<CalendarEventUpsertResult> {
    if (!this.calendarId) {
      throw new Error('GOOGLE_CALENDAR_ID is empty after trim');
    }

    const diagnostics = toGoogleDiagnosticsContext(event);
    const bookingId = diagnostics.bookingId ?? event.privateMetadata?.['booking_id'] ?? null;

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
        has_booking_id_metadata: Boolean(bookingId),
        has_event_id_hint: Boolean(options?.eventIdHint),
        branch_taken: 'call_google_events_insert',
        deny_reason: null,
      },
    });

    const token = await getServiceAccountAccessToken(this.env, this.logger, {
      calendarOperation: 'create_event',
      bookingId: diagnostics.bookingId,
      requestId: diagnostics.requestId,
    });
    await this.applyBurstThrottle(diagnostics.bookingId, diagnostics.requestId);

    const existing = bookingId
      ? await this.findExistingEventByBookingId(token, bookingId, diagnostics.requestId)
      : null;
    if (existing) {
      this.logger?.logInfo?.({
        source: 'backend',
        eventType: 'google_calendar_insert_idempotent_hit',
        message: 'Skipped Google Calendar insert because an event already exists for the booking id',
        context: {
          booking_id: diagnostics.bookingId,
          request_id: diagnostics.requestId,
          google_event_id: existing.eventId,
          branch_taken: 'reuse_existing_event_by_booking_id',
          deny_reason: null,
        },
      });
      return existing;
    }

    const calId = encodeURIComponent(this.calendarId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?sendUpdates=none&conferenceDataVersion=1`;
    const initialBody = JSON.stringify(
      buildGoogleEventBody(event, {
        eventIdHint: options?.eventIdHint ?? null,
        createConference: true,
      }),
    );
    const initialRes = await this.postCalendarEvent(url, token, initialBody);

    if (initialRes.ok) {
      const initialData = await initialRes.json() as GoogleCalendarEventResponse;
      const data = await this.hydrateConferenceDataIfMissing(token, initialData, {
        bookingId: diagnostics.bookingId,
        requestId: diagnostics.requestId,
        operation: 'create_event',
      });
      const result = toCalendarUpsertResult(data);
      this.logger?.logInfo?.({
        source: 'backend',
        eventType: 'google_calendar_insert_completed',
        message: 'Google Calendar events.insert succeeded',
        context: {
          booking_id: diagnostics.bookingId,
          request_id: diagnostics.requestId,
          google_event_id: result.eventId,
          meeting_provider: result.meetingProvider,
          has_meeting_link: Boolean(result.meetingLink),
          meeting_link_source: detectMeetingLinkSource(data),
          branch_taken: result.meetingLink ? 'google_event_created_with_meet_link' : 'google_event_created_without_meet_link',
          deny_reason: result.meetingLink ? null : 'google_meet_link_missing_in_create_response',
        },
      });
      return result;
    }

    if (initialRes.status === 409 && options?.eventIdHint) {
      return this.updateEvent(options.eventIdHint, event);
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
      branchTaken: isRetryableWriteFailure(initialRes.status, initialGoogleError)
        ? 'google_events_insert_failed_retryable_quota_limit'
        : 'google_events_insert_failed',
    });
    if (isRetryableWriteFailure(initialRes.status, initialGoogleError)) {
      throw new RetryableCalendarWriteErrorClass(
        `Google createEvent failed (${initialRes.status}): ${initialErrorBody}`,
        {
          statusCode: initialRes.status,
          reason: initialGoogleError.reason,
        },
      );
    }
    throw new Error(`Google createEvent failed (${initialRes.status}): ${initialErrorBody}`);
  }

  async updateEvent(eventId: string, event: CalendarEvent): Promise<CalendarEventUpsertResult> {
    if (!this.calendarId) {
      throw new Error('GOOGLE_CALENDAR_ID is empty after trim');
    }
    const diagnostics = toGoogleDiagnosticsContext(event);
    this.logger?.logInfo?.({
      source: 'backend',
      eventType: 'google_calendar_update_request',
      message: 'Preparing Google Calendar events.update request',
      context: {
        booking_id: diagnostics.bookingId,
        request_id: diagnostics.requestId,
        google_event_id: eventId,
        calendar_id_present: this.calendarId.length > 0,
        calendar_id_was_trimmed: this.calendarIdWasTrimmed,
        calendar_id_shape: this.calendarId.includes('@') ? 'email_like' : 'opaque_id_like',
        branch_taken: 'call_google_events_update',
        deny_reason: null,
      },
    });
    const token = await getServiceAccountAccessToken(this.env, this.logger, {
      calendarOperation: 'update_event',
      bookingId: diagnostics.bookingId,
      requestId: diagnostics.requestId,
    });
    const calId = encodeURIComponent(this.calendarId);
    const evId  = encodeURIComponent(eventId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${evId}?sendUpdates=none&conferenceDataVersion=1`;
    const initialBody = JSON.stringify(
      buildGoogleEventBody(event, {
        eventIdHint: null,
        createConference: true,
      }),
    );
    const initialRes = await this.putCalendarEvent(url, token, initialBody);
    if (initialRes.ok) {
      const initialData = await initialRes.json() as GoogleCalendarEventResponse;
      const data = await this.hydrateConferenceDataIfMissing(token, initialData, {
        bookingId: diagnostics.bookingId,
        requestId: diagnostics.requestId,
        operation: 'update_event',
      });
      const result = toCalendarUpsertResult(data);
      this.logger?.logInfo?.({
        source: 'backend',
        eventType: 'google_calendar_update_completed',
        message: 'Google Calendar events.update succeeded',
        context: {
          booking_id: diagnostics.bookingId,
          request_id: diagnostics.requestId,
          google_event_id: result.eventId,
          meeting_provider: result.meetingProvider,
          has_meeting_link: Boolean(result.meetingLink),
          meeting_link_source: detectMeetingLinkSource(data),
          branch_taken: result.meetingLink ? 'google_event_updated_with_meet_link' : 'google_event_updated_without_meet_link',
          deny_reason: null,
        },
      });
      return result;
    }

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
    this.logger?.logInfo?.({
      source: 'backend',
      eventType: 'google_calendar_delete_request',
      message: 'Preparing Google Calendar events.delete request',
      context: {
        google_event_id: eventId,
        calendar_id_present: this.calendarId.length > 0,
        calendar_id_was_trimmed: this.calendarIdWasTrimmed,
        calendar_id_shape: this.calendarId.includes('@') ? 'email_like' : 'opaque_id_like',
        branch_taken: 'call_google_events_delete',
        deny_reason: null,
      },
    });
    const token = await getServiceAccountAccessToken(this.env, this.logger, {
      calendarOperation: 'delete_event',
    });
    const calId = encodeURIComponent(this.calendarId);
    const evId  = encodeURIComponent(eventId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${evId}?sendUpdates=none`;
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

    if (res.ok) {
      this.logger?.logInfo?.({
        source: 'backend',
        eventType: 'google_calendar_delete_completed',
        message: 'Google Calendar events.delete succeeded',
        context: {
          google_event_id: eventId,
          branch_taken: 'google_event_deleted',
          deny_reason: null,
        },
      });
      return;
    }

    if (res.status === 404 || res.status === 410) {
      this.logger?.logInfo?.({
        source: 'backend',
        eventType: 'google_calendar_delete_completed',
        message: 'Google Calendar event already absent; treating delete as success',
        context: {
          google_event_id: eventId,
          google_http_status: res.status,
          branch_taken: 'google_event_already_absent_treated_as_success',
          deny_reason: 'google_event_not_found',
        },
      });
      return;
    }

    if (!res.ok) {
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
  options: { eventIdHint: string | null; createConference: boolean },
): Record<string, unknown> {
  const conferenceRequestId = crypto.randomUUID();
  return {
    ...(options.eventIdHint ? { id: options.eventIdHint } : {}),
    summary: event.title,
    description: event.description,
    location: event.location,
    start: { dateTime: event.startIso, timeZone: event.timezone },
    end: { dateTime: event.endIso, timeZone: event.timezone },
    ...(options.createConference
      ? {
        conferenceData: {
          createRequest: {
            requestId: conferenceRequestId,
            conferenceSolutionKey: {
              type: 'hangoutsMeet',
            },
          },
        },
      }
      : {}),
    ...(event.privateMetadata ? { extendedProperties: { private: event.privateMetadata } } : {}),
  };
}

function toCalendarUpsertResult(data: GoogleCalendarEventResponse): CalendarEventUpsertResult {
  const meetingLink = extractGoogleMeetLink(data);
  return {
    eventId: data.id,
    htmlLink: typeof data.htmlLink === 'string' && data.htmlLink.trim() ? data.htmlLink.trim() : null,
    meetingProvider: meetingLink ? 'google_meet' : null,
    meetingLink,
  };
}

function extractGoogleMeetLink(data: GoogleCalendarEventResponse): string | null {
  const videoEntryPoint = data.conferenceData?.entryPoints?.find(
    (entryPoint) => entryPoint.entryPointType === 'video' && typeof entryPoint.uri === 'string' && entryPoint.uri.trim(),
  );
  if (videoEntryPoint?.uri?.trim()) {
    return videoEntryPoint.uri.trim();
  }

  if (typeof data.hangoutLink === 'string' && data.hangoutLink.trim()) {
    return data.hangoutLink.trim();
  }
  return null;
}

function detectMeetingLinkSource(data: GoogleCalendarEventResponse): 'hangoutLink' | 'conferenceData.video' | 'missing' {
  if (typeof data.hangoutLink === 'string' && data.hangoutLink.trim()) {
    return 'hangoutLink';
  }
  return data.conferenceData?.entryPoints?.some(
    (entryPoint) => entryPoint.entryPointType === 'video' && typeof entryPoint.uri === 'string' && entryPoint.uri.trim(),
  )
    ? 'conferenceData.video'
    : 'missing';
}

function readConferenceCreateStatus(data: GoogleCalendarEventResponse): string | null {
  const statusCode = data.conferenceData?.createRequest?.status?.statusCode;
  return typeof statusCode === 'string' && statusCode.trim() ? statusCode.trim() : null;
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
