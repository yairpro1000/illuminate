import { describe, expect, it, vi } from 'vitest';
import { createObservabilityLogger, type PersistedLogEvent } from '../../shared/observability/backend.js';
import { shouldPersistWorkerLogEvent } from '../src/lib/observability.js';

describe('worker observability persistence policy', () => {
  it('suppresses noisy info and keeps high-signal events', () => {
    const capture = vi.fn(async (_event: PersistedLogEvent) => {});
    const logger = createObservabilityLogger({
      sink: {
        isConfigured: () => true,
        capture,
      } as any,
      defaults: { source: 'worker' },
      shouldPersist: shouldPersistWorkerLogEvent,
    });

    logger.info('info message');
    logger.logMilestone('incoming_request_received', { path: '/api/events/ev-04-new-earth/book-with-access' });
    logger.logProviderCall({
      provider: 'repository',
      operation: 'getEventBySlug',
      success: true,
    });
    logger.warn('warn message');
    logger.error('error message');

    expect(capture).toHaveBeenCalledTimes(3);
    expect(capture).toHaveBeenNthCalledWith(1, expect.objectContaining({
      base: expect.objectContaining({ level: 'info', eventType: 'flow_milestone' }),
    }));
    expect(capture).toHaveBeenNthCalledWith(2, expect.objectContaining({
      base: expect.objectContaining({ level: 'warn' }),
    }));
    expect(capture).toHaveBeenNthCalledWith(3, expect.objectContaining({
      base: expect.objectContaining({ level: 'error' }),
    }));
  });

  it('exposes a deterministic predicate for selective info suppression', () => {
    expect(shouldPersistWorkerLogEvent({
      base: { source: 'backend', level: 'info', eventType: 'x' },
    })).toBe(true);
    expect(shouldPersistWorkerLogEvent({
      base: { source: 'provider', level: 'info', eventType: 'provider_call' },
    })).toBe(false);
    expect(shouldPersistWorkerLogEvent({
      base: { source: 'worker', level: 'info', eventType: 'message' },
    })).toBe(false);
    expect(shouldPersistWorkerLogEvent({
      base: { source: 'backend', level: 'warn', eventType: 'x' },
    })).toBe(true);
    expect(shouldPersistWorkerLogEvent({
      base: { source: 'provider', level: 'error', eventType: 'x' },
      api: {
        direction: 'outbound',
        provider: 'repository',
        success: false,
      },
    })).toBe(true);
  });
});
