import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../src/providers/calendar/google.js';
import { RetryableCalendarWriteError } from '../src/providers/calendar/interface.js';

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'google-event-1',
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const created = await provider.createEvent(makeCalendarEvent() as any);

    const tokenUrl = String(fetchMock.mock.calls[0]?.[0] ?? '');
    const tokenRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const tokenBody = String(tokenRequest?.body ?? '');
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(tokenRequest?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(tokenBody).toContain('client_id=oauth-client-id');
    expect(tokenBody).toContain('client_secret=oauth-client-secret');
    expect(tokenBody).toContain('refresh_token=oauth-refresh-token');
    expect(tokenBody).toContain('grant_type=refresh_token');

    const lookupUrl = String(fetchMock.mock.calls[1]?.[0] ?? '');
    expect(lookupUrl).toContain('/calendars/yairilluminate%40gmail.com/events?');
    expect(lookupUrl).toContain('privateExtendedProperty=booking_id%3Db1');

    const insertUrl = String(fetchMock.mock.calls[2]?.[0] ?? '');
    expect(insertUrl).toContain('/calendars/yairilluminate%40gmail.com/events?sendUpdates=all&conferenceDataVersion=1');
    expect(insertUrl).not.toContain('%0A');
    expect(insertUrl).not.toContain('%20');

    const insertBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body ?? '{}')) as Record<string, unknown>;
    expect(insertBody['attendees']).toEqual([{ email: 'test@example.com', displayName: 'Test User' }]);
    expect(insertBody['conferenceData']).toEqual({
      createRequest: {
        requestId: expect.any(String),
      },
    });
    expect(created).toEqual({
      eventId: 'google-event-1',
      meetingProvider: 'google_meet',
      meetingLink: 'https://meet.google.com/abc-defg-hij',
    });
  });

  it('falls back to conferenceData video entry points when hangoutLink is missing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'google-event-2',
        conferenceData: {
          entryPoints: [
            { entryPointType: 'more', uri: 'https://calendar.google.com' },
            { entryPointType: 'video', uri: 'https://meet.google.com/fallback-link' },
          ],
        },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const created = await provider.createEvent(makeCalendarEvent() as any);

    expect(created).toEqual({
      eventId: 'google-event-2',
      meetingProvider: 'google_meet',
      meetingLink: 'https://meet.google.com/fallback-link',
    });
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
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

  it('reuses an existing event when booking_id metadata already exists on the calendar', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: 'google-event-existing',
          hangoutLink: 'https://meet.google.com/existing-link',
        }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const logger = {
      logProviderCall: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    } as any;

    const provider = makeProvider(logger);
    const created = await provider.createEvent(makeCalendarEvent() as any);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(created).toEqual({
      eventId: 'google-event-existing',
      meetingProvider: 'google_meet',
      meetingLink: 'https://meet.google.com/existing-link',
    });
    expect(logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'google_calendar_insert_idempotent_hit',
      context: expect.objectContaining({
        google_event_id: 'google-event-existing',
        branch_taken: 'reuse_existing_event_by_booking_id',
      }),
    }));
  });

  it('throws RetryableCalendarWriteError for retryable quotaExceeded insert failures', async () => {
    const failureBody = {
      error: {
        code: 403,
        message: 'Calendar usage limits exceeded.',
        errors: [{ reason: 'quotaExceeded' }],
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(failureBody), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();

    await expect(provider.createEvent(makeCalendarEvent() as any)).rejects.toBeInstanceOf(RetryableCalendarWriteError);
  });
});
