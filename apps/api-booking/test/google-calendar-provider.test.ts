import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../src/providers/calendar/google.js';

function makeCalendarEvent(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Test',
    description: 'Desc',
    startIso: '2026-03-20T10:00:00.000Z',
    endIso: '2026-03-20T11:00:00.000Z',
    timezone: 'Europe/Zurich',
    location: 'Via Example 1',
    attendeeEmail: 'test@example.com',
    attendeeName: 'Test User',
    privateMetadata: { booking_id: 'b1', request_id: 'req-1' },
    ...overrides,
  };
}

function makeProvider(logger?: any) {
  return new GoogleCalendarProvider({
    GOOGLE_CLIENT_CALENDAR: 'oauth-client-id',
    GOOGLE_CLIENT_SECRET_CALENDAR: 'oauth-client-secret',
    GOOGLE_REFRESH_TOKEN_CALENDAR: 'oauth-refresh-token',
    GOOGLE_CLIENT_EMAIL: 'svc@example.iam.gserviceaccount.com',
    GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    GOOGLE_TOKEN_URI: 'https://oauth2.googleapis.com/token',
    GOOGLE_CALENDAR_ID: ' yairilluminate@gmail.com \n',
  }, logger);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GoogleCalendarProvider OAuth diagnostics', () => {
  it('exchanges refresh token and inserts attendee event into trimmed calendar id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'google-event-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    await provider.createEvent(makeCalendarEvent() as any);

    const tokenUrl = String(fetchMock.mock.calls[0]?.[0] ?? '');
    const tokenRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const tokenBody = String(tokenRequest?.body ?? '');
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(tokenRequest?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(tokenBody).toContain('client_id=oauth-client-id');
    expect(tokenBody).toContain('client_secret=oauth-client-secret');
    expect(tokenBody).toContain('refresh_token=oauth-refresh-token');
    expect(tokenBody).toContain('grant_type=refresh_token');

    const insertUrl = String(fetchMock.mock.calls[1]?.[0] ?? '');
    expect(insertUrl).toContain('/calendars/yairilluminate%40gmail.com/events?sendUpdates=all');
    expect(insertUrl).not.toContain('%0A');
    expect(insertUrl).not.toContain('%20');

    const insertBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? '{}')) as Record<string, unknown>;
    expect(insertBody['attendees']).toEqual([{ email: 'test@example.com', displayName: 'Test User' }]);
  });

  it('logs booking_id, request_id, and google response body when events.insert fails', async () => {
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

    const provider = makeProvider(logger);

    await expect(provider.createEvent(makeCalendarEvent() as any)).rejects.toThrow('Google createEvent failed (400)');

    expect(logger.logError).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'google_calendar_insert_failed',
      context: expect.objectContaining({
        booking_id: 'b1',
        request_id: 'req-1',
        google_http_status: 400,
        google_error_reason: 'invalid',
        google_response_body: expect.stringContaining('Invalid resource id value'),
      }),
    }));
  });

  it('aborts createEvent and logs clearly when token exchange fails', async () => {
    const tokenFailureBody = {
      error: 'invalid_grant',
      error_description: 'Bad refresh token.',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(tokenFailureBody), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const logger = {
      logProviderCall: vi.fn(),
      logInfo: vi.fn(),
      logError: vi.fn(),
    } as any;

    const provider = makeProvider(logger);

    await expect(provider.createEvent(makeCalendarEvent() as any)).rejects.toThrow('Google token exchange failed (400)');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(logger.logError).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'google_calendar_token_exchange_failed',
      context: expect.objectContaining({
        booking_id: 'b1',
        request_id: 'req-1',
        google_http_status: 400,
        google_error_reason: 'invalid_grant',
        google_response_body: expect.stringContaining('invalid_grant'),
        branch_taken: 'abort_calendar_write_token_exchange_failed',
      }),
    }));
  });
});
