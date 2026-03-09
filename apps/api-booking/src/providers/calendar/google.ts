import type { ICalendarProvider, CalendarEvent, CreateCalendarEventOptions } from './interface.js';
import type { TimeSlot } from '../../types.js';
import type { Logger } from '../../lib/observability.js';
import { instrumentFetch } from '../../../../shared/observability/backend.js';

interface GoogleEnv {
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_TOKEN_URI: string;
  GOOGLE_CALENDAR_ID: string;
}

// ── In-memory freeBusy cache (60 s TTL) ───────────────────────────────────────

const freeBusyCache = new Map<string, { data: TimeSlot[]; expires: number }>();
const MAX_FREEBUSY_CHUNK_DAYS = 90;

// ── JWT (RS256) using Web Crypto API — no Node.js crypto needed ───────────────

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

  // Cloudflare secrets often store newlines as literal \n — normalise first,
  // then strip PEM headers/footers and whitespace to get raw base64 DER.
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

async function getAccessToken(env: GoogleEnv, logger?: Logger): Promise<string> {
  const jwt = await createServiceAccountJWT(env);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion:  jwt,
  });

  const res = logger
    ? await instrumentFetch(logger, {
        provider: 'google_calendar',
        operation: 'token_exchange',
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
    const body = await res.text();
    console.error('Google Calendar error', { stage: 'token', status: res.status, body: body.slice(0, 500) });
    throw new Error(`Google token exchange failed (${res.status})`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class GoogleCalendarProvider implements ICalendarProvider {
  constructor(private env: GoogleEnv, private logger?: Logger) {}

  async getBusyTimes(from: string, to: string): Promise<TimeSlot[]> {
    const cacheKey = `${this.env.GOOGLE_CALENDAR_ID}:${from}:${to}`;
    const cached   = freeBusyCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }

    const token = await getAccessToken(this.env, this.logger);
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
    const payload = {
      timeMin: `${from}T00:00:00Z`,
      timeMax: `${to}T23:59:59Z`,
      items:   [{ id: this.env.GOOGLE_CALENDAR_ID }],
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

    return data.calendars[this.env.GOOGLE_CALENDAR_ID]?.busy ?? [];
  }

  async createEvent(event: CalendarEvent, options?: CreateCalendarEventOptions): Promise<{ eventId: string }> {
    const token = await getAccessToken(this.env, this.logger);
    const calId = encodeURIComponent(this.env.GOOGLE_CALENDAR_ID);
    const body = JSON.stringify({
      ...(options?.eventIdHint ? { id: options.eventIdHint } : {}),
      summary:     event.title,
      description: event.description,
      location:    event.location,
      start:       { dateTime: event.startIso, timeZone: event.timezone },
      end:         { dateTime: event.endIso, timeZone: event.timezone },
      attendees:   [{ email: event.attendeeEmail, displayName: event.attendeeName }],
      ...(event.privateMetadata ? { extendedProperties: { private: event.privateMetadata } } : {}),
    });
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`;
    const res = this.logger
      ? await instrumentFetch(this.logger, {
          provider: 'google_calendar',
          operation: 'create_event',
          method: 'POST',
          url,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
        })
      : await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
        });

    if (!res.ok) {
      if (res.status === 409 && options?.eventIdHint) {
        await this.updateEvent(options.eventIdHint, event);
        return { eventId: options.eventIdHint };
      }
      const body = await res.text();
      throw new Error(`Google createEvent failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { id: string };
    return { eventId: data.id };
  }

  async updateEvent(eventId: string, event: CalendarEvent): Promise<void> {
    const token = await getAccessToken(this.env, this.logger);
    const calId = encodeURIComponent(this.env.GOOGLE_CALENDAR_ID);
    const evId  = encodeURIComponent(eventId);
    const body = JSON.stringify({
      summary:     event.title,
      description: event.description,
      location:    event.location,
      start:       { dateTime: event.startIso, timeZone: event.timezone },
      end:         { dateTime: event.endIso, timeZone: event.timezone },
      attendees:   [{ email: event.attendeeEmail, displayName: event.attendeeName }],
      ...(event.privateMetadata ? { extendedProperties: { private: event.privateMetadata } } : {}),
    });
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${evId}`;
    const res = this.logger
      ? await instrumentFetch(this.logger, {
          provider: 'google_calendar',
          operation: 'update_event',
          method: 'PUT',
          url,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
        })
      : await fetch(url, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
        });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google updateEvent failed (${res.status}): ${body}`);
    }
  }

  async deleteEvent(eventId: string): Promise<void> {
    const token = await getAccessToken(this.env, this.logger);
    const calId = encodeURIComponent(this.env.GOOGLE_CALENDAR_ID);
    const evId  = encodeURIComponent(eventId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${evId}`;
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
      throw new Error(`Google deleteEvent failed (${res.status}): ${body}`);
    }
  }
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
