import { describe, expect, it, vi } from 'vitest';
import {
  cancelBookingsByClientPrefix,
  inspectBookingsByClientPrefix,
  parseCancelClientPrefixArgs,
} from '../scripts/lib/cancel-bookings-by-client-prefix.mjs';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('cancel client prefix maintenance script', () => {
  it('parses args with defaults and execute flag', () => {
    expect(parseCancelClientPrefixArgs([
      '--email-prefix=p4-clean',
      '--execute',
      '--limit=4',
      '--api-base-url=https://api.example.com/',
    ], {})).toEqual({
      apiBaseUrl: 'https://api.example.com/',
      emailPrefix: 'p4-clean',
      limit: 4,
      execute: true,
      help: false,
    });
  });

  it('inspects matching bookings through the count endpoint', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      email_prefix: 'p4-clean',
      count: 2,
      bookings: [
        { booking_id: 'b1', status: 'PENDING', client_email: 'p4-clean-a@example.test' },
        { booking_id: 'b2', status: 'CANCELED', client_email: 'p4-clean-b@example.test' },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const summary = await inspectBookingsByClientPrefix({
      apiBaseUrl: 'https://api.example.com/',
      emailPrefix: ' P4-Clean ',
      logger,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/api/__test/bookings?email_prefix=p4-clean',
      { method: 'GET' },
    );
    expect(summary).toEqual({
      email_prefix: 'p4-clean',
      count: 2,
      bookings: [
        { booking_id: 'b1', status: 'PENDING', client_email: 'p4-clean-a@example.test' },
        { booking_id: 'b2', status: 'CANCELED', client_email: 'p4-clean-b@example.test' },
      ],
    });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cancel_client_prefix_inspection_request_completed',
      context: expect.objectContaining({
        email_prefix: 'p4-clean',
        branch_taken: 'return_cancel_client_prefix_inspection_request',
      }),
    }));
  });

  it('executes cleanup through the cleanup endpoint', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      email_prefix: 'p4-clean',
      matched_count: 3,
      active_matched_count: 2,
      processed_count: 2,
      remaining_active_count: 0,
      batch_limit: 2,
      canceled_count: 2,
      skipped_count: 1,
      failed_count: 0,
      canceled: [
        { booking_id: 'b1', status: 'CANCELED' },
        { booking_id: 'b2', status: 'CANCELED' },
      ],
      skipped: [
        { booking_id: 'b3', status: 'CANCELED', reason: 'already_terminal' },
      ],
      failed: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const summary = await cancelBookingsByClientPrefix({
      apiBaseUrl: 'https://api.example.com',
      emailPrefix: 'p4-clean',
      limit: 2,
      execute: true,
      logger,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/api/__test/bookings/cleanup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_prefix: 'p4-clean',
          limit: 2,
        }),
      },
    );
    expect(summary.canceled_count).toBe(2);
    expect(summary.skipped_count).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cancel_client_prefix_cleanup_request_completed',
      context: expect.objectContaining({
        email_prefix: 'p4-clean',
        batch_limit: 2,
        branch_taken: 'return_cancel_client_prefix_cleanup_request',
      }),
    }));
  });

  it('rejects missing email prefix with explicit diagnostics', async () => {
    const logger = makeLogger();

    await expect(inspectBookingsByClientPrefix({
      apiBaseUrl: 'https://api.example.com',
      emailPrefix: '   ',
      logger,
      fetchImpl: vi.fn(),
    })).rejects.toThrow('email prefix is required');

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'cancel_client_prefix_inspection_rejected',
      context: expect.objectContaining({
        branch_taken: 'deny_missing_email_prefix',
        deny_reason: 'email_prefix_missing',
      }),
    }));
  });
});
