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
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: 'svc@example.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
    GOOGLE_CALENDAR_ID: ' yairilluminate@gmail.com \n',
  }, logger);
}

function makeInvalidProviderWithoutServiceAccountJson(logger?: any) {
  return new GoogleCalendarProvider({
    GOOGLE_CALENDAR_ID: 'calendar@example.com',
  }, logger);
}

function stubServiceAccountSigning() {
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn().mockReturnValue('uuid-123'),
    subtle: {
      importKey: vi.fn().mockResolvedValue('private-key'),
      sign: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    },
  } as unknown as Crypto);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GoogleCalendarProvider service-account diagnostics', () => {
  it('exchanges a service-account token and inserts a no-notification event into the trimmed calendar id', async () => {
    stubServiceAccountSigning();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'google-event-1',
        htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-1',
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
    expect(tokenBody).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(tokenBody).toContain('assertion=');

    const lookupUrl = String(fetchMock.mock.calls[1]?.[0] ?? '');
    expect(lookupUrl).toContain('/calendars/yairilluminate%40gmail.com/events?');
    expect(lookupUrl).toContain('privateExtendedProperty=booking_id%3Db1');

    const insertUrl = String(fetchMock.mock.calls[2]?.[0] ?? '');
    expect(insertUrl).toContain('/calendars/yairilluminate%40gmail.com/events?sendUpdates=none&conferenceDataVersion=1');
    expect(insertUrl).not.toContain('%0A');
    expect(insertUrl).not.toContain('%20');

    const insertBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body ?? '{}')) as Record<string, unknown>;
    expect(insertBody).not.toHaveProperty('attendees');
    expect(insertBody['conferenceData']).toEqual({
      createRequest: {
        requestId: 'uuid-123',
        conferenceSolutionKey: {
          type: 'hangoutsMeet',
        },
      },
    });
    expect(created).toEqual({
      eventId: 'google-event-1',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-1',
      meetingProvider: 'google_meet',
      meetingLink: 'https://meet.google.com/abc-defg-hij',
    });
  });

  it('falls back to conferenceData video entry points when hangoutLink is missing', async () => {
    stubServiceAccountSigning();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'google-event-2',
        htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-2',
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
      htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-2',
      meetingProvider: 'google_meet',
      meetingLink: 'https://meet.google.com/fallback-link',
    });
  });

  it('hydrates the event after insert when the initial response is missing meet data', async () => {
    stubServiceAccountSigning();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'google-event-hydrate',
        htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-hydrate',
        conferenceData: {
          createRequest: {
            status: {
              statusCode: 'pending',
            },
          },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'google-event-hydrate',
        htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-hydrate',
        conferenceData: {
          entryPoints: [
            { entryPointType: 'video', uri: 'https://meet.google.com/hydrated-link' },
          ],
        },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const created = await provider.createEvent(makeCalendarEvent() as any);

    expect(String(fetchMock.mock.calls[3]?.[0] ?? '')).toContain('/events/google-event-hydrate?conferenceDataVersion=1');
    expect(created).toEqual({
      eventId: 'google-event-hydrate',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-hydrate',
      meetingProvider: 'google_meet',
      meetingLink: 'https://meet.google.com/hydrated-link',
    });
  });

  it('logs booking_id, request_id, and google response body when events.insert fails', async () => {
    stubServiceAccountSigning();
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
    stubServiceAccountSigning();
    const tokenFailureBody = {
      error: 'invalid_grant',
      error_description: 'Service account is not authorized for this calendar.',
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

    await expect(provider.createEvent(makeCalendarEvent() as any)).rejects.toThrow('Google service-account token exchange failed (400)');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(logger.logError).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'google_calendar_service_account_token_exchange_failed',
      context: expect.objectContaining({
        auth_mode: 'service_account',
        calendar_operation: 'create_event',
        booking_id: 'b1',
        request_id: 'req-1',
        google_http_status: 400,
        google_error_reason: 'invalid_grant',
        google_response_body: expect.stringContaining('invalid_grant'),
        branch_taken: 'abort_calendar_operation_service_account_token_exchange_failed',
      }),
    }));
  });

  it('fails fast when GOOGLE_SERVICE_ACCOUNT_JSON is missing for calendar writes', async () => {
    stubServiceAccountSigning();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const logger = {
      logProviderCall: vi.fn(),
      logInfo: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    } as any;

    const provider = makeInvalidProviderWithoutServiceAccountJson(logger);
    await expect(provider.createEvent(makeCalendarEvent() as any)).rejects.toThrow(
      'GOOGLE_SERVICE_ACCOUNT_JSON is required for Google Calendar service-account authentication',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.logError).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'google_calendar_service_account_config_invalid',
      context: expect.objectContaining({
        auth_config_source: 'service_account_json',
        calendar_operation: 'create_event',
        branch_taken: 'abort_calendar_operation_missing_service_account_json',
      }),
    }));
  });

  it('reuses an existing event when booking_id metadata already exists on the calendar', async () => {
    stubServiceAccountSigning();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: 'google-event-existing',
          htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-existing',
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
      htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-existing',
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
    stubServiceAccountSigning();
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

  it('uses the service-account token path for updateEvent and logs the request', async () => {
    stubServiceAccountSigning();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'google-event-3',
        htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-3',
        hangoutLink: 'https://meet.google.com/updated-link',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const logger = {
      logProviderCall: vi.fn(),
      logInfo: vi.fn(),
      logError: vi.fn(),
    } as any;

    const provider = makeProvider(logger);
    const updated = await provider.updateEvent('google-event-3', makeCalendarEvent() as any);

    const tokenBody = String((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body ?? '');
    expect(tokenBody).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(String(fetchMock.mock.calls[1]?.[0] ?? '')).toContain('/events/google-event-3?sendUpdates=none&conferenceDataVersion=1');
    const updateBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? '{}')) as Record<string, unknown>;
    expect(updateBody).not.toHaveProperty('attendees');
    expect(updateBody['conferenceData']).toEqual({
      createRequest: {
        requestId: 'uuid-123',
        conferenceSolutionKey: {
          type: 'hangoutsMeet',
        },
      },
    });
    expect(updated).toEqual({
      eventId: 'google-event-3',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=google-event-3',
      meetingProvider: 'google_meet',
      meetingLink: 'https://meet.google.com/updated-link',
    });
    expect(logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'google_calendar_update_request',
      context: expect.objectContaining({
        google_event_id: 'google-event-3',
        branch_taken: 'call_google_events_update',
      }),
    }));
  });

  it('uses the service-account token path for deleteEvent and treats 404 as success', async () => {
    stubServiceAccountSigning();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const logger = {
      logProviderCall: vi.fn(),
      logInfo: vi.fn(),
      logError: vi.fn(),
    } as any;

    const provider = makeProvider(logger);
    await expect(provider.deleteEvent('google-event-4')).resolves.toBeUndefined();

    const tokenBody = String((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body ?? '');
    expect(tokenBody).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(String(fetchMock.mock.calls[1]?.[0] ?? '')).toContain('/events/google-event-4?sendUpdates=none');
    expect(logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'google_calendar_delete_completed',
      context: expect.objectContaining({
        google_event_id: 'google-event-4',
        google_http_status: 404,
        branch_taken: 'google_event_already_absent_treated_as_success',
      }),
    }));
  });
});
