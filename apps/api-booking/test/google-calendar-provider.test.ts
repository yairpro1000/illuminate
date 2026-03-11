import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../src/providers/calendar/google.js';

async function makePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g)?.join('\n') ?? base64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

function makeCalendarEvent() {
  return {
    title: 'Test',
    description: 'Desc',
    startIso: '2026-03-20T10:00:00.000Z',
    endIso: '2026-03-20T11:00:00.000Z',
    timezone: 'Europe/Zurich',
    location: 'Via Example 1',
    attendeeEmail: 'test@example.com',
    attendeeName: 'Test User',
    privateMetadata: { booking_id: 'b1' },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GoogleCalendarProvider diagnostics', () => {
  it('trims GOOGLE_CALENDAR_ID before events.insert URL generation', async () => {
    const privateKey = await makePrivateKeyPem();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'google-event-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const logger = {
      logProviderCall: vi.fn(),
      logInfo: vi.fn(),
      logError: vi.fn(),
    } as any;

    const provider = new GoogleCalendarProvider({
      GOOGLE_CLIENT_EMAIL: 'svc@example.iam.gserviceaccount.com',
      GOOGLE_PRIVATE_KEY: privateKey,
      GOOGLE_TOKEN_URI: 'https://oauth2.googleapis.com/token',
      GOOGLE_CALENDAR_ID: ' yairilluminate@gmail.com \n',
    }, logger);

    await provider.createEvent(makeCalendarEvent());

    const insertUrl = String(fetchMock.mock.calls[1]?.[0] ?? '');
    expect(insertUrl).toContain('/calendars/yairilluminate%40gmail.com/events');
    expect(insertUrl).not.toContain('%0A');
    expect(insertUrl).not.toContain('%20');
  });

  it('logs parsed Google API deny reason when events.insert fails', async () => {
    const privateKey = await makePrivateKeyPem();
    const failureBody = {
      error: {
        code: 400,
        message: 'Invalid resource id value.',
        status: 'INVALID_ARGUMENT',
        errors: [{ reason: 'invalid' }],
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(failureBody), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const logger = {
      logProviderCall: vi.fn(),
      logInfo: vi.fn(),
      logError: vi.fn(),
    } as any;

    const provider = new GoogleCalendarProvider({
      GOOGLE_CLIENT_EMAIL: 'svc@example.iam.gserviceaccount.com',
      GOOGLE_PRIVATE_KEY: privateKey,
      GOOGLE_TOKEN_URI: 'https://oauth2.googleapis.com/token',
      GOOGLE_CALENDAR_ID: 'yairilluminate@gmail.com',
    }, logger);

    await expect(provider.createEvent(makeCalendarEvent())).rejects.toThrow('Google createEvent failed (400)');

    expect(logger.logError).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'google_calendar_insert_failed',
      context: expect.objectContaining({
        google_http_status: 400,
        google_error_reason: 'invalid',
        deny_reason: 'invalid',
      }),
    }));
  });
});
