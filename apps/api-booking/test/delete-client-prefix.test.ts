import { describe, expect, it, vi } from 'vitest';
import { purgeClientDataByEmailPrefix } from '../scripts/lib/delete-client-prefix.mjs';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeDeletingDbFixture({
  clients = [],
  bookings = [],
  bookingEvents = [],
  bookingSideEffects = [],
  bookingSideEffectAttempts = [],
  payments = [],
  contactMessages = [],
  reminderSubscriptions = [],
  apiLogs = [],
  exceptionLogs = [],
  deleteSelectResponseLimitByTable = {},
} = {}) {
  const deleteOrder: string[] = [];
  const rowsByTable = {
    clients,
    bookings,
    booking_events: bookingEvents,
    booking_side_effects: bookingSideEffects,
    booking_side_effect_attempts: bookingSideEffectAttempts,
    payments,
    contact_messages: contactMessages,
    event_reminder_subscriptions: reminderSubscriptions,
    api_logs: apiLogs,
    exception_logs: exceptionLogs,
  } as Record<string, Array<Record<string, unknown>>>;
  const deleteResponseLimitByTableState = {
    ...deleteSelectResponseLimitByTable,
  } as Record<string, number>;

  return {
    deleteOrder,
    db: {
      from(table: string) {
        const state = {
          mode: 'select',
          ids: [] as string[],
          orClause: null as string | null,
        };

        const getKeyCandidates = (row: Record<string, unknown>) => [
          row.id,
          row.client_id,
          row.booking_id,
          row.booking_event_id,
          row.booking_side_effect_id,
          row.side_effect_id,
          row.side_effect_attempt_id,
        ].filter((value): value is string => typeof value === 'string');

        const matchesOrClause = (row: Record<string, unknown>) => {
          if (!state.orClause) return true;
          const clauses = state.orClause.split(',').filter(Boolean);
          return clauses.some((clause) => {
            const match = clause.match(/^([a-z_]+)\.in\.\((.*)\)$/);
            if (!match) return false;
            const [, column, rawValues] = match;
            const values = rawValues.split(',').filter(Boolean);
            return values.includes(String(row[column]));
          });
        };

        return {
          select(_columns?: string) {
            if (state.mode === 'delete') {
              deleteOrder.push(table);
              const deleted = (rowsByTable[table] ?? []).filter((row) => state.ids.includes(String(row.id)));
              rowsByTable[table] = (rowsByTable[table] ?? []).filter((row) => !state.ids.includes(String(row.id)));
              const responseLimit = deleteResponseLimitByTableState[table];
              return Promise.resolve({
                data: typeof responseLimit === 'number' ? deleted.slice(0, responseLimit) : deleted,
                error: null,
              });
            }
            return this;
          },
          ilike() {
            return this;
          },
          order() {
            return this;
          },
          in(_column: string, ids: string[]) {
            state.ids = ids;
            return this;
          },
          or(clause: string) {
            state.orClause = clause;
            return this;
          },
          delete() {
            state.mode = 'delete';
            return this;
          },
          async then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
            if (state.mode === 'delete') {
              deleteOrder.push(table);
              const deleted = (rowsByTable[table] ?? []).filter((row) => state.ids.includes(String(row.id)));
              rowsByTable[table] = (rowsByTable[table] ?? []).filter((row) => !state.ids.includes(String(row.id)));
              const responseLimit = deleteResponseLimitByTableState[table];
              return resolve({
                data: typeof responseLimit === 'number' ? deleted.slice(0, responseLimit) : deleted,
                error: null,
              });
            }
            const data = state.ids.length > 0
              ? (rowsByTable[table] ?? []).filter((row) =>
                getKeyCandidates(row).some((key) => state.ids.includes(String(key))))
              : (rowsByTable[table] ?? []).filter((row) => matchesOrClause(row));
            return resolve({ data, error: null });
          },
        };
      },
    },
  };
}

describe('delete client prefix maintenance script', () => {
  it('returns a dry-run plan without deleting anything', async () => {
    const logger = makeLogger();
    const fixture = makeDeletingDbFixture({
      clients: [
        { id: 'c1', email: 'p4-clean-a@example.test', first_name: 'A', last_name: null },
      ],
      bookings: [
        { id: 'b1', client_id: 'c1', current_status: 'PENDING', starts_at: '2026-03-30T10:00:00.000Z', ends_at: '2026-03-30T10:30:00.000Z' },
      ],
      bookingEvents: [
        { id: 'be1', booking_id: 'b1', event_type: 'BOOKING_FORM_SUBMITTED', created_at: '2026-03-01T10:00:00.000Z' },
      ],
      bookingSideEffects: [
        { id: 'se1', booking_event_id: 'be1', effect_intent: 'SEND_BOOKING_CONFIRMATION_REQUEST', status: 'SUCCESS' },
      ],
      bookingSideEffectAttempts: [
        { id: 'sea1', booking_side_effect_id: 'se1', status: 'SUCCESS' },
      ],
      payments: [
        { id: 'p1', booking_id: 'b1', status: 'PENDING' },
      ],
      contactMessages: [
        { id: 'm1', client_id: 'c1', status: 'NEW' },
      ],
      reminderSubscriptions: [
        { id: 'r1', email: 'p4-clean-a@example.test', event_family: 'illuminate_evenings' },
      ],
      apiLogs: [
        { id: 'al1', booking_id: 'b1', booking_event_id: 'be1', side_effect_id: 'se1', side_effect_attempt_id: 'sea1' },
      ],
      exceptionLogs: [
        { id: 'el1', booking_id: 'b1', booking_event_id: 'be1', side_effect_id: 'se1', side_effect_attempt_id: 'sea1' },
      ],
    });

    const summary = await purgeClientDataByEmailPrefix({
      db: fixture.db as any,
      emailPrefix: ' p4-clean ',
      execute: false,
      logger,
    });

    expect(summary.email_prefix).toBe('p4-clean');
    expect(summary.matched_client_count).toBe(1);
    expect(summary.matched_booking_count).toBe(1);
    expect(summary.matched_booking_event_count).toBe(1);
    expect(summary.matched_booking_side_effect_count).toBe(1);
    expect(summary.matched_booking_side_effect_attempt_count).toBe(1);
    expect(summary.matched_payment_count).toBe(1);
    expect(summary.matched_contact_message_count).toBe(1);
    expect(summary.matched_event_reminder_subscription_count).toBe(1);
    expect(summary.matched_api_log_count).toBe(1);
    expect(summary.matched_exception_log_count).toBe(1);
    expect(summary.deleted_counts).toEqual({
      contact_messages: 0,
      event_reminder_subscriptions: 0,
      api_logs: 0,
      exception_logs: 0,
      booking_side_effect_attempts: 0,
      booking_side_effects: 0,
      booking_events: 0,
      payments: 0,
      bookings: 0,
      clients: 0,
    });
    expect(fixture.deleteOrder).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'client_prefix_purge_plan_ready',
      context: expect.objectContaining({
        branch_taken: 'return_dry_run_plan',
        deny_reason: 'dry_run_only',
      }),
    }));
  });

  it('deletes rows in FK-safe order when execute is enabled', async () => {
    const logger = makeLogger();
    const fixture = makeDeletingDbFixture({
      clients: [
        { id: 'c1', email: 'p4-clean-a@example.test', first_name: 'A', last_name: null },
      ],
      bookings: [
        { id: 'b1', client_id: 'c1', current_status: 'PENDING', starts_at: '2026-03-30T10:00:00.000Z', ends_at: '2026-03-30T10:30:00.000Z' },
      ],
      bookingEvents: [
        { id: 'be1', booking_id: 'b1', event_type: 'BOOKING_FORM_SUBMITTED', created_at: '2026-03-01T10:00:00.000Z' },
      ],
      bookingSideEffects: [
        { id: 'se1', booking_event_id: 'be1', effect_intent: 'SEND_BOOKING_CONFIRMATION_REQUEST', status: 'SUCCESS' },
      ],
      bookingSideEffectAttempts: [
        { id: 'sea1', booking_side_effect_id: 'se1', status: 'SUCCESS' },
      ],
      payments: [
        { id: 'p1', booking_id: 'b1', status: 'PENDING' },
      ],
      contactMessages: [
        { id: 'm1', client_id: 'c1', status: 'NEW' },
      ],
      reminderSubscriptions: [
        { id: 'r1', email: 'p4-clean-a@example.test', event_family: 'illuminate_evenings' },
      ],
      apiLogs: [
        { id: 'al1', booking_id: 'b1', booking_event_id: 'be1', side_effect_id: 'se1', side_effect_attempt_id: 'sea1' },
      ],
      exceptionLogs: [
        { id: 'el1', booking_id: 'b1', booking_event_id: 'be1', side_effect_id: 'se1', side_effect_attempt_id: 'sea1' },
      ],
    });

    const summary = await purgeClientDataByEmailPrefix({
      db: fixture.db as any,
      emailPrefix: 'p4-clean',
      execute: true,
      logger,
    });

    expect(fixture.deleteOrder).toEqual([
      'contact_messages',
      'event_reminder_subscriptions',
      'api_logs',
      'exception_logs',
      'booking_side_effect_attempts',
      'booking_side_effects',
      'booking_events',
      'payments',
      'bookings',
      'clients',
    ]);
    expect(summary.deleted_counts).toEqual({
      contact_messages: 1,
      event_reminder_subscriptions: 1,
      api_logs: 1,
      exception_logs: 1,
      booking_side_effect_attempts: 1,
      booking_side_effects: 1,
      booking_events: 1,
      payments: 1,
      bookings: 1,
      clients: 1,
    });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'client_prefix_purge_completed',
      context: expect.objectContaining({
        deleted_contact_message_count: 1,
        deleted_event_reminder_subscription_count: 1,
        deleted_api_log_count: 1,
        deleted_exception_log_count: 1,
        deleted_booking_side_effect_attempt_count: 1,
        deleted_booking_side_effect_count: 1,
        deleted_booking_event_count: 1,
        deleted_payment_count: 1,
        deleted_booking_count: 1,
        deleted_client_count: 1,
        branch_taken: 'client_prefix_purge_completed',
      }),
    }));
  });

  it('verifies deletion by re-query instead of trusting delete response row counts', async () => {
    const logger = makeLogger();
    const fixture = makeDeletingDbFixture({
      clients: [
        { id: 'c1', email: 'p4-clean-a@example.test', first_name: 'A', last_name: null },
      ],
      bookings: [
        { id: 'b1', client_id: 'c1', current_status: 'PENDING', starts_at: '2026-03-30T10:00:00.000Z', ends_at: '2026-03-30T10:30:00.000Z' },
      ],
      bookingEvents: [
        { id: 'be1', booking_id: 'b1', event_type: 'BOOKING_FORM_SUBMITTED', created_at: '2026-03-01T10:00:00.000Z' },
      ],
      bookingSideEffects: [
        { id: 'se1', booking_event_id: 'be1', effect_intent: 'SEND_BOOKING_CONFIRMATION_REQUEST', status: 'SUCCESS' },
      ],
      bookingSideEffectAttempts: [
        { id: 'sea1', booking_side_effect_id: 'se1', status: 'SUCCESS' },
      ],
      deleteSelectResponseLimitByTable: {
        booking_side_effect_attempts: 0,
      },
    });

    const summary = await purgeClientDataByEmailPrefix({
      db: fixture.db as any,
      emailPrefix: 'p4-clean',
      execute: true,
      logger,
    });

    expect(summary.deleted_counts.booking_side_effect_attempts).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'client_prefix_delete_batch_completed',
      context: expect.objectContaining({
        table: 'booking_side_effect_attempts',
        deleted_count: 1,
        post_delete_remaining_count: 0,
        branch_taken: 'delete_batch_completed',
      }),
    }));
  });

  it('rejects a missing email prefix with explicit diagnostics', async () => {
    const logger = makeLogger();
    const fixture = makeDeletingDbFixture();

    await expect(purgeClientDataByEmailPrefix({
      db: fixture.db as any,
      emailPrefix: '  ',
      execute: false,
      logger,
    })).rejects.toThrow('email prefix is required');

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'client_prefix_purge_rejected',
      context: expect.objectContaining({
        branch_taken: 'deny_missing_email_prefix',
        deny_reason: 'email_prefix_missing',
      }),
    }));
  });
});
