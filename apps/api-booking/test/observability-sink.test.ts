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
});
