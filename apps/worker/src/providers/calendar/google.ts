import type { ICalendarProvider, CalendarEvent } from './interface.js';
import type { TimeSlot } from '../../types.js';

interface GoogleEnv {
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_TOKEN_URI: string;
  GOOGLE_CALENDAR_ID: string;
}

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

  // Strip PEM headers/footers and whitespace to get raw base64 DER.
  // Cloudflare secrets often store newlines as literal \n — normalise first.
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

async function getAccessToken(env: GoogleEnv): Promise<string> {
  const jwt = await createServiceAccountJWT(env);

  const res = await fetch(env.GOOGLE_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class GoogleCalendarProvider implements ICalendarProvider {
  constructor(private env: GoogleEnv) {}

  async getBusyTimes(from: string, to: string): Promise<TimeSlot[]> {
    const token = await getAccessToken(this.env);

    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin:  `${from}T00:00:00Z`,
        timeMax:  `${to}T23:59:59Z`,
        timeZone: 'UTC',
        items:    [{ id: this.env.GOOGLE_CALENDAR_ID }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google freeBusy failed (${res.status}): ${body}`);
    }

    const data = await res.json() as {
      calendars: Record<string, { busy: Array<{ start: string; end: string }> }>;
    };

    return data.calendars[this.env.GOOGLE_CALENDAR_ID]?.busy ?? [];
  }

  async createEvent(event: CalendarEvent): Promise<{ eventId: string }> {
    const token = await getAccessToken(this.env);
    const calId = encodeURIComponent(this.env.GOOGLE_CALENDAR_ID);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary:     event.title,
          description: event.description,
          location:    event.location,
          start:       { dateTime: event.startIso },
          end:         { dateTime: event.endIso },
          attendees:   [{ email: event.attendeeEmail, displayName: event.attendeeName }],
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google createEvent failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { id: string };
    return { eventId: data.id };
  }

  async updateEvent(eventId: string, event: CalendarEvent): Promise<void> {
    const token = await getAccessToken(this.env);
    const calId = encodeURIComponent(this.env.GOOGLE_CALENDAR_ID);
    const evId  = encodeURIComponent(eventId);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${evId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary:     event.title,
          description: event.description,
          location:    event.location,
          start:       { dateTime: event.startIso },
          end:         { dateTime: event.endIso },
          attendees:   [{ email: event.attendeeEmail, displayName: event.attendeeName }],
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google updateEvent failed (${res.status}): ${body}`);
    }
  }

  async deleteEvent(eventId: string): Promise<void> {
    const token = await getAccessToken(this.env);
    const calId = encodeURIComponent(this.env.GOOGLE_CALENDAR_ID);
    const evId  = encodeURIComponent(eventId);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${evId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      },
    );

    // 404 / 410 = already gone — treat as success (idempotent)
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      const body = await res.text();
      throw new Error(`Google deleteEvent failed (${res.status}): ${body}`);
    }
  }
}
