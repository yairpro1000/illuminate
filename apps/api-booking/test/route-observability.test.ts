import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '../src/lib/execution.js';

const insertCalls: Array<{ schema: string; table: string; row: Record<string, unknown> }> = [];
const updateCalls: Array<{ schema: string; table: string; id: string; row: Record<string, unknown> }> = [];

vi.mock('../src/repo/supabase.js', () => ({
  makeSupabase: vi.fn(() => ({
    schema: vi.fn((schemaName: string) => ({
      from: vi.fn((table: string) => ({
        insert: vi.fn((row: Record<string, unknown>) => {
          insertCalls.push({ schema: schemaName, table, row });
          return {
            select: vi.fn(() => ({
              single: vi.fn(async () => ({ data: { id: `api-log-${insertCalls.length}` }, error: null })),
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

import { handleRequest } from '../src/router.js';
import { makeCtx } from './admin-helpers.js';

describe('shared inbound observability wrapper', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    updateCalls.length = 0;
  });

  it('writes api_logs for handled admin 401 responses on non-booking routes', async () => {
    const ctx = makeCtx({
      env: {
        SUPABASE_URL: 'https://supabase.test',
        SUPABASE_SECRET_KEY: 'secret',
        OBSERVABILITY_SCHEMA: 'public',
      } as any,
      requestId: 'req-admin-1',
      correlationId: 'corr-admin-1',
      operation: createOperationContext({
        appArea: 'admin',
        requestId: 'req-admin-1',
        correlationId: 'corr-admin-1',
      }),
    });
    const req = new Request('https://api.local/api/admin/config', { method: 'GET' });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(401);
    expect(insertCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        app_area: 'admin',
        request_id: 'req-admin-1',
        correlation_id: 'corr-admin-1',
        direction: 'inbound',
        method: 'GET',
      }),
    }));
    expect(updateCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        response_status: 401,
        error_code: null,
      }),
    }));
  });

  it('writes api_logs for handled public 500 responses on non-booking routes', async () => {
    const ctx = makeCtx({
      env: {
        SUPABASE_URL: 'https://supabase.test',
        SUPABASE_SECRET_KEY: 'secret',
        OBSERVABILITY_SCHEMA: 'public',
      } as any,
      requestId: 'req-site-1',
      correlationId: 'corr-site-1',
      providers: {
        repository: {
          getPublishedEvents: vi.fn(async () => {
            throw new Error('db exploded');
          }),
        },
      } as any,
      operation: createOperationContext({
        appArea: 'website',
        requestId: 'req-site-1',
        correlationId: 'corr-site-1',
      }),
    });
    const req = new Request('https://api.local/api/events', { method: 'GET' });

    const res = await handleRequest(req, ctx);

    expect(res.status).toBe(500);
    expect(insertCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        app_area: 'website',
        request_id: 'req-site-1',
        correlation_id: 'corr-site-1',
        direction: 'inbound',
        url: 'https://api.local/api/events',
      }),
    }));
    expect(updateCalls).toContainEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
      row: expect.objectContaining({
        response_status: 500,
        error_code: null,
      }),
    }));
  });
});
