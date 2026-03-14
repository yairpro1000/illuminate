import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockRepository } from '../src/providers/repository/mock.js';
import { makeEnv } from './admin-helpers.js';

const insertCalls: Array<{ schema: string; table: string; row: Record<string, unknown> }> = [];
const updateCalls: Array<{ schema: string; table: string; id: string; row: Record<string, unknown> }> = [];
const mockCreateProviders = vi.fn();

vi.mock('../src/repo/supabase.js', () => ({
  makeSupabase: vi.fn(() => ({
    schema: vi.fn((schemaName: string) => ({
      from: vi.fn((table: string) => ({
        insert: vi.fn((row: Record<string, unknown>) => {
          insertCalls.push({ schema: schemaName, table, row });
          return {
            select: vi.fn(() => ({
              single: vi.fn(async () => ({ data: { id: `${table}-${insertCalls.length}` }, error: null })),
            })),
          };
        }),
        update: vi.fn((row: Record<string, unknown>) => ({
          eq: vi.fn(async (_column: string, id: string) => {
            updateCalls.push({ schema: schemaName, table, id, row });
            return { error: null };
          }),
        })),
      })),
    })),
  })),
}));

vi.mock('../src/providers/index.js', () => ({
  createProviders: (...args: unknown[]) => mockCreateProviders(...args),
}));

import worker from '../src/index.js';

function makeExecutionCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

function makeProviders(overrides: Record<string, unknown> = {}) {
  return {
    repository: Object.assign(new MockRepository(), overrides.repository as Record<string, unknown> | undefined),
    email: {},
    calendar: {},
    payments: {},
    antibot: {},
    ...overrides,
  } as any;
}

describe('worker fetch observability coverage', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    updateCalls.length = 0;
    mockCreateProviders.mockReset();
  });

  it('writes api_logs for handled admin 401 responses', async () => {
    mockCreateProviders.mockReturnValue(makeProviders());
    const env = makeEnv({
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SECRET_KEY: 'secret',
      OBSERVABILITY_SCHEMA: 'public',
    });
    const req = new Request('https://api.local/api/admin/config', { method: 'GET' });

    const res = await worker.fetch(req, env, makeExecutionCtx());

    expect(res.status).toBe(401);
    expect(insertCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        app_area: 'admin',
        direction: 'inbound',
        method: 'GET',
        url: 'https://api.local/api/admin/config',
      }),
    }));
    expect(updateCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        response_status: 401,
      }),
    }));
  });

  it('writes api_logs for unmatched 404 responses', async () => {
    mockCreateProviders.mockReturnValue(makeProviders());
    const env = makeEnv({
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SECRET_KEY: 'secret',
      OBSERVABILITY_SCHEMA: 'public',
    });
    const req = new Request('https://api.local/api/nope', { method: 'GET' });

    const res = await worker.fetch(req, env, makeExecutionCtx());

    expect(res.status).toBe(404);
    expect(insertCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        app_area: 'website',
        direction: 'inbound',
        url: 'https://api.local/api/nope',
      }),
    }));
    expect(updateCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        response_status: 404,
      }),
    }));
  });

  it('writes api_logs for method-not-allowed 405 responses', async () => {
    mockCreateProviders.mockReturnValue(makeProviders());
    const env = makeEnv({
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SECRET_KEY: 'secret',
      OBSERVABILITY_SCHEMA: 'public',
    });
    const req = new Request('https://api.local/api/health', { method: 'POST' });

    const res = await worker.fetch(req, env, makeExecutionCtx());

    expect(res.status).toBe(405);
    expect(updateCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        response_status: 405,
      }),
    }));
  });

  it('writes api_logs for non-api 404 responses returned by the worker', async () => {
    mockCreateProviders.mockReturnValue(makeProviders());
    const env = makeEnv({
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SECRET_KEY: 'secret',
      OBSERVABILITY_SCHEMA: 'public',
    });
    const req = new Request('https://api.local/nope', { method: 'GET' });

    const res = await worker.fetch(req, env, makeExecutionCtx());

    expect(res.status).toBe(404);
    expect(updateCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        response_status: 404,
      }),
    }));
  });

  it('writes api_logs for denied preflight responses', async () => {
    mockCreateProviders.mockReturnValue(makeProviders());
    const env = makeEnv({
      SITE_URL: 'https://letsilluminate.co',
      API_ALLOWED_ORIGINS: '',
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SECRET_KEY: 'secret',
      OBSERVABILITY_SCHEMA: 'public',
    });
    const req = new Request('https://api.local/api/admin/config', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });

    const res = await worker.fetch(req, env, makeExecutionCtx());

    expect(res.status).toBe(403);
    expect(updateCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        response_status: 403,
      }),
    }));
  });

  it('writes exception_logs for uncaught matched-route failures', async () => {
    mockCreateProviders.mockReturnValue(makeProviders({
      repository: {
        getBookingById: vi.fn(async () => {
          throw new Error('booking lookup failed');
        }),
      },
    }));
    const env = makeEnv({
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SECRET_KEY: 'secret',
      OBSERVABILITY_SCHEMA: 'public',
    });
    const req = new Request('https://api.local/api/bookings/manage?token=123e4567-e89b-42d3-a456-426614174000', { method: 'GET' });

    const res = await worker.fetch(req, env, makeExecutionCtx());

    expect(res.status).toBe(500);
    expect(insertCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'exception_logs',
      row: expect.objectContaining({
        app_area: 'website',
        error_code: 'INTERNAL_ERROR',
      }),
    }));
    expect(updateCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        response_status: 500,
        error_code: 'INTERNAL_ERROR',
        error_message: 'booking lookup failed',
        response_body_preview: {
          error: 'INTERNAL_ERROR',
          message: 'Internal server error',
          request_id: expect.any(String),
        },
      }),
    }));
  });

  it('writes actionable api_logs and exception_logs for public events route failures', async () => {
    mockCreateProviders.mockReturnValue(makeProviders({
      repository: {
        getPublishedEvents: vi.fn(async () => {
          throw new Error('Failed to load published events: column events.capacity does not exist | code=42703 | hint=Perhaps you meant to reference a different column. | status=400');
        }),
      },
    }));
    const env = makeEnv({
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SECRET_KEY: 'secret',
      OBSERVABILITY_SCHEMA: 'public',
    });
    const req = new Request('https://api.local/api/events', { method: 'GET' });

    const res = await worker.fetch(req, env, makeExecutionCtx());

    expect(res.status).toBe(500);
    expect(updateCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        response_status: 500,
        error_code: 'INTERNAL_ERROR',
        error_message: 'Failed to load published events: column events.capacity does not exist | code=42703 | hint=Perhaps you meant to reference a different column. | status=400',
        response_body_preview: {
          error: 'INTERNAL_ERROR',
          message: 'Internal server error',
          request_id: expect.any(String),
        },
      }),
    }));
    expect(insertCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'exception_logs',
      row: expect.objectContaining({
        app_area: 'website',
        error_code: 'INTERNAL_ERROR',
        message: 'Failed to load published events: column events.capacity does not exist | code=42703 | hint=Perhaps you meant to reference a different column. | status=400',
      }),
    }));
  });

  it('writes api_logs and exception_logs for top-level fetch failures before routing completes', async () => {
    mockCreateProviders.mockImplementation(() => {
      throw new Error('provider init failed');
    });
    const env = makeEnv({
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SECRET_KEY: 'secret',
      OBSERVABILITY_SCHEMA: 'public',
    });
    const req = new Request('https://api.local/api/health', { method: 'GET' });

    const res = await worker.fetch(req, env, makeExecutionCtx());

    expect(res.status).toBe(500);
    expect(insertCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        app_area: 'website',
        direction: 'inbound',
        url: 'https://api.local/api/health',
      }),
    }));
    expect(updateCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        response_status: 500,
        error_code: 'INTERNAL_ERROR',
      }),
    }));
    expect(insertCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'exception_logs',
      row: expect.objectContaining({
        app_area: 'website',
        error_code: 'INTERNAL_ERROR',
      }),
    }));
  });
});
