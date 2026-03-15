import { describe, expect, it, vi } from 'vitest';
import { purgeClientDataByEmailPrefix } from '../scripts/lib/delete-client-prefix.mjs';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeDbFixture({
  clients = [],
  bookings = [],
  payments = [],
  contactMessages = [],
  reminderSubscriptions = [],
} = {}) {
  const deleteOrder: string[] = [];

  const selectRowsByTable = {
    clients,
    bookings,
    payments,
    contact_messages: contactMessages,
    event_reminder_subscriptions: reminderSubscriptions,
  } as Record<string, Array<Record<string, unknown>>>;

  return {
    deleteOrder,
    db: {
      from(table: string) {
        return {
          select() {
            return this;
          },
          ilike() {
            return Promise.resolve({ data: selectRowsByTable[table] ?? [], error: null });
          },
          order() {
            return Promise.resolve({ data: selectRowsByTable[table] ?? [], error: null });
          },
          in() {
            return this;
          },
          delete() {
            return this;
          },
          async select(_columns?: string) {
            if (arguments.length > 0 && deleteOrder.includes(table)) {
              return { data: [], error: null };
            }
            return { data: selectRowsByTable[table] ?? [], error: null };
          },
          async then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
            return resolve({ data: selectRowsByTable[table] ?? [], error: null });
          },
        };
      },
    },
    markDeleted(table: string, rows: Array<Record<string, unknown>>) {
      deleteOrder.push(table);
      selectRowsByTable[table] = rows;
    },
  };
}

function makeDeletingDbFixture({
  clients = [],
  bookings = [],
  payments = [],
  contactMessages = [],
  reminderSubscriptions = [],
} = {}) {
  const deleteOrder: string[] = [];
  const rowsByTable = {
    clients,
    bookings,
    payments,
    contact_messages: contactMessages,
    event_reminder_subscriptions: reminderSubscriptions,
  } as Record<string, Array<Record<string, unknown>>>;

  return {
    deleteOrder,
    db: {
      from(table: string) {
        const state = {
          mode: 'select',
          ids: [] as string[],
        };

        return {
          select() {
            return this;
          },
          ilike() {
            return Promise.resolve({ data: rowsByTable[table] ?? [], error: null });
          },
          order() {
            return Promise.resolve({ data: rowsByTable[table] ?? [], error: null });
          },
          in(_column: string, ids: string[]) {
            state.ids = ids;
            return this;
          },
          delete() {
            state.mode = 'delete';
            return this;
          },
          async select(_columns?: string) {
            if (state.mode === 'delete') {
              deleteOrder.push(table);
              const deleted = (rowsByTable[table] ?? []).filter((row) => state.ids.includes(String(row.id)));
              rowsByTable[table] = (rowsByTable[table] ?? []).filter((row) => !state.ids.includes(String(row.id)));
              return { data: deleted, error: null };
            }
            return { data: rowsByTable[table] ?? [], error: null };
          },
          async then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
            return resolve({ data: rowsByTable[table] ?? [], error: null });
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
      payments: [
        { id: 'p1', booking_id: 'b1', status: 'PENDING' },
      ],
      contactMessages: [
        { id: 'm1', client_id: 'c1', status: 'NEW' },
      ],
      reminderSubscriptions: [
        { id: 'r1', email: 'p4-clean-a@example.test', event_family: 'illuminate_evenings' },
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
    expect(summary.matched_payment_count).toBe(1);
    expect(summary.matched_contact_message_count).toBe(1);
    expect(summary.matched_event_reminder_subscription_count).toBe(1);
    expect(summary.deleted_counts).toEqual({
      contact_messages: 0,
      event_reminder_subscriptions: 0,
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
      payments: [
        { id: 'p1', booking_id: 'b1', status: 'PENDING' },
      ],
      contactMessages: [
        { id: 'm1', client_id: 'c1', status: 'NEW' },
      ],
      reminderSubscriptions: [
        { id: 'r1', email: 'p4-clean-a@example.test', event_family: 'illuminate_evenings' },
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
      'payments',
      'bookings',
      'clients',
    ]);
    expect(summary.deleted_counts).toEqual({
      contact_messages: 1,
      event_reminder_subscriptions: 1,
      payments: 1,
      bookings: 1,
      clients: 1,
    });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'client_prefix_purge_completed',
      context: expect.objectContaining({
        deleted_contact_message_count: 1,
        deleted_event_reminder_subscription_count: 1,
        deleted_payment_count: 1,
        deleted_booking_count: 1,
        deleted_client_count: 1,
        branch_taken: 'client_prefix_purge_completed',
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
