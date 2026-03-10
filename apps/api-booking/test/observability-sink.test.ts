import { describe, expect, it, vi } from 'vitest';
import { SupabaseObservabilitySink } from '../../shared/observability/backend.js';

describe('SupabaseObservabilitySink', () => {
  it('preserves fetch invocation context for Workers-style fetch functions', async () => {
    let called = false;
    async function workerLikeFetch(this: typeof globalThis, _input: string, _init?: RequestInit) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      }
      called = true;
      return new Response(JSON.stringify([{ id: 'log-1' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const sink = new SupabaseObservabilitySink({
      supabaseUrl: 'https://supabase.local',
      secretKey: 'secret',
      fetchFn: workerLikeFetch as typeof fetch,
    });

    await sink.capture({
      base: {
        source: 'worker',
        level: 'info',
        eventType: 'request',
        message: 'GET /',
        requestId: 'req-1',
        correlationId: 'corr-1',
        route: '/',
        context: {},
      },
    });

    expect(called).toBe(true);
  });

  it('disables further inserts after PGRST106 schema exposure error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'PGRST106',
          message: 'Invalid schema: observability',
          hint: 'Only the following schemas are exposed: public, graphql_public',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const sink = new SupabaseObservabilitySink({
      supabaseUrl: 'https://supabase.local',
      secretKey: 'secret',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const event = {
      base: {
        source: 'worker' as const,
        level: 'info' as const,
        eventType: 'request',
        message: 'GET /',
        requestId: 'req-1',
        correlationId: 'corr-1',
        route: '/',
        context: {},
      },
    };

    await sink.capture(event);
    await sink.capture(event);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
