import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEnv } from './admin-helpers.js';

const handleRequestMock = vi.fn();
const createProvidersMock = vi.fn(() => ({
  repository: {},
  email: {},
  calendar: {},
  payments: {},
  antibot: {},
}));
const startApiLogMock = vi.fn(async () => 'api-log-1');
const finalizeApiLogMock = vi.fn(async () => undefined);
const recordExceptionLogMock = vi.fn(async () => undefined);

vi.mock('../src/providers/index.js', () => ({
  createProviders: (...args: unknown[]) => createProvidersMock(...args),
}));

vi.mock('../src/router.js', () => ({
  handleRequest: (...args: unknown[]) => handleRequestMock(...args),
}));

vi.mock('../src/lib/technical-observability.js', () => ({
  startApiLog: (...args: unknown[]) => startApiLogMock(...args),
  finalizeApiLog: (...args: unknown[]) => finalizeApiLogMock(...args),
  recordExceptionLog: (...args: unknown[]) => recordExceptionLogMock(...args),
  responseUrl: () => '/api/bookings/pay-now',
  wrapProvidersForOperation: (providers: unknown) => providers,
}));

import worker from '../src/index.js';

function makeExecutionCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('worker operation reference propagation', () => {
  beforeEach(() => {
    handleRequestMock.mockReset();
    createProvidersMock.mockClear();
    startApiLogMock.mockClear();
    finalizeApiLogMock.mockClear();
    recordExceptionLogMock.mockClear();
  });

  it('finalizes inbound api_logs with booking references learned inside the route layer', async () => {
    handleRequestMock.mockImplementation(async (_request, ctx) => {
      ctx.operation.bookingId = 'booking-1';
      ctx.operation.bookingEventId = 'event-1';
      ctx.operation.sideEffectId = 'side-effect-1';
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await worker.fetch(
      new Request('https://api.local/api/bookings/pay-now', { method: 'POST', body: '{}' }),
      makeEnv(),
      makeExecutionCtx(),
    );

    expect(finalizeApiLogMock).toHaveBeenCalledWith(
      expect.anything(),
      'api-log-1',
      expect.objectContaining({
        operation: expect.objectContaining({
          bookingId: 'booking-1',
          bookingEventId: 'event-1',
          sideEffectId: 'side-effect-1',
        }),
      }),
    );
  });

  it('writes exception_logs with booking references learned before the route throws', async () => {
    handleRequestMock.mockImplementation(async (_request, ctx) => {
      ctx.operation.bookingId = 'booking-2';
      ctx.operation.bookingEventId = 'event-2';
      ctx.operation.sideEffectId = 'side-effect-2';
      throw new Error('boom');
    });

    const response = await worker.fetch(
      new Request('https://api.local/api/bookings/pay-now', { method: 'POST', body: '{}' }),
      makeEnv(),
      makeExecutionCtx(),
    );

    expect(response.status).toBe(500);
    expect(recordExceptionLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bookingId: 'booking-2',
        bookingEventId: 'event-2',
        sideEffectId: 'side-effect-2',
      }),
      expect.any(Error),
      expect.any(Object),
      'INTERNAL_ERROR',
    );
    expect(finalizeApiLogMock).toHaveBeenCalledWith(
      expect.anything(),
      'api-log-1',
      expect.objectContaining({
        operation: expect.objectContaining({
          bookingId: 'booking-2',
          bookingEventId: 'event-2',
          sideEffectId: 'side-effect-2',
        }),
      }),
    );
  });
});
