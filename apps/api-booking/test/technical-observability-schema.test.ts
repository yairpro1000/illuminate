import { beforeEach, describe, expect, it, vi } from 'vitest';

const schemaCalls: string[] = [];
const insertAttempts: Array<{ schema: string; table: string; row: Record<string, unknown> }> = [];

vi.mock('../src/repo/supabase.js', () => ({
  makeSupabase: vi.fn(() => ({
    schema: vi.fn((schemaName: string) => {
      schemaCalls.push(schemaName);
      return {
        from: vi.fn((table: string) => ({
          insert: vi.fn((row: Record<string, unknown>) => {
            insertAttempts.push({ schema: schemaName, table, row });
            return {
              select: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: schemaName === 'public' ? { id: 'api-log-public' } : null,
                  error: schemaName === 'public' ? null : { message: `relation "${schemaName}.${table}" does not exist` },
                })),
              })),
            };
          }),
          update: vi.fn(() => ({
            eq: vi.fn(async () => ({ error: null })),
          })),
        })),
      };
    }),
  })),
}));

import { createOperationContext } from '../src/lib/execution.js';
import { startApiLog } from '../src/lib/technical-observability.js';

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SECRET_KEY: 'secret',
    OBSERVABILITY_SCHEMA: 'public',
    ...overrides,
  } as any;
}

describe('technical observability schema selection', () => {
  beforeEach(() => {
    schemaCalls.length = 0;
    insertAttempts.length = 0;
  });

  it('defaults to public when OBSERVABILITY_SCHEMA is unset', async () => {
    const apiLogId = await startApiLog(makeEnv({ OBSERVABILITY_SCHEMA: '' }), {
      operation: createOperationContext({
        appArea: 'website',
        requestId: 'req-1',
        correlationId: 'corr-1',
      }),
      direction: 'inbound',
      method: 'GET',
      url: 'https://api.local/api/events',
    });

    expect(apiLogId).toBe('api-log-public');
    expect(schemaCalls[0]).toBe('public');
    expect(insertAttempts[0]).toEqual(expect.objectContaining({
      schema: 'public',
      table: 'api_logs',
    }));
  });

  it('falls back to public when a stale configured schema is missing', async () => {
    const apiLogId = await startApiLog(makeEnv({ OBSERVABILITY_SCHEMA: 'observability' }), {
      operation: createOperationContext({
        appArea: 'website',
        requestId: 'req-2',
        correlationId: 'corr-2',
      }),
      direction: 'inbound',
      method: 'GET',
      url: 'https://api.local/api/events',
    });

    expect(apiLogId).toBe('api-log-public');
    expect(schemaCalls).toEqual(['observability', 'public']);
    expect(insertAttempts).toEqual([
      expect.objectContaining({ schema: 'observability', table: 'api_logs' }),
      expect.objectContaining({ schema: 'public', table: 'api_logs' }),
    ]);
  });
});
