import { chunkValues, escapeLikePrefix, normalizeLowercasePrefix } from '../../src/lib/prefix-utils.js';
import { createConsoleLogger } from './maintenance-logger.mjs';

const DEFAULT_DELETE_BATCH_SIZE = 100;

export function parseDeleteClientPrefixArgs(argv) {
  let emailPrefix = null;
  let execute = false;
  let help = false;

  for (const arg of argv) {
    if (arg === '--execute') {
      execute = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg.startsWith('--email-prefix=')) {
      emailPrefix = arg.slice('--email-prefix='.length);
      continue;
    }
    if (arg.startsWith('--prefix=')) {
      emailPrefix = arg.slice('--prefix='.length);
      continue;
    }
  }

  return {
    emailPrefix,
    execute,
    help,
  };
}

function info(logger, eventType, message, context) {
  logger.info({ source: 'maintenance', eventType, message, context });
}

function warn(logger, eventType, message, context) {
  logger.warn({ source: 'maintenance', eventType, message, context });
}

function error(logger, eventType, message, context) {
  logger.error({ source: 'maintenance', eventType, message, context });
}

async function requireRows(queryPromise, failureMessage) {
  const { data, error: queryError } = await queryPromise;
  if (queryError) {
    throw new Error(`${failureMessage}: ${queryError.message}`);
  }
  return Array.isArray(data) ? data : [];
}

async function deleteRowsByIds({
  db,
  table,
  ids,
  logger,
  emailPrefix,
  deleteBatchSize = DEFAULT_DELETE_BATCH_SIZE,
}) {
  if (ids.length === 0) return 0;

  let deletedCount = 0;
  const batches = chunkValues(ids, deleteBatchSize);
  for (const [batchIndex, batchIds] of batches.entries()) {
    info(logger, 'client_prefix_delete_batch_started', 'Started delete batch', {
      email_prefix: emailPrefix,
      table,
      batch_index: batchIndex + 1,
      batch_count: batches.length,
      batch_size: batchIds.length,
      branch_taken: 'delete_batch',
    });

    const deletedRows = await requireRows(
      db.from(table).delete().in('id', batchIds).select('id'),
      `Failed to delete rows from ${table}`,
    );

    if (deletedRows.length !== batchIds.length) {
      throw new Error(`Delete count mismatch for ${table}: expected ${batchIds.length}, deleted ${deletedRows.length}`);
    }

    deletedCount += deletedRows.length;
    info(logger, 'client_prefix_delete_batch_completed', 'Completed delete batch', {
      email_prefix: emailPrefix,
      table,
      batch_index: batchIndex + 1,
      batch_count: batches.length,
      deleted_count: deletedRows.length,
      branch_taken: 'delete_batch_completed',
    });
  }

  return deletedCount;
}

export async function purgeClientDataByEmailPrefix({
  db,
  emailPrefix,
  execute = false,
  logger = createConsoleLogger(),
  deleteBatchSize = DEFAULT_DELETE_BATCH_SIZE,
}) {
  const normalizedPrefix = normalizeLowercasePrefix(emailPrefix);

  info(logger, 'client_prefix_purge_started', 'Started client-prefix purge planning', {
    email_prefix_raw: emailPrefix ?? null,
    execute,
    delete_batch_size: deleteBatchSize,
    branch_taken: 'validate_client_prefix_purge_request',
  });

  if (!normalizedPrefix) {
    warn(logger, 'client_prefix_purge_rejected', 'Rejected client-prefix purge because email prefix was missing', {
      branch_taken: 'deny_missing_email_prefix',
      deny_reason: 'email_prefix_missing',
    });
    throw new Error('email prefix is required');
  }

  const escapedPrefix = escapeLikePrefix(normalizedPrefix);
  const clients = await requireRows(
    db.from('clients')
      .select('id, email, first_name, last_name')
      .ilike('email', `${escapedPrefix}%`)
      .order('email', { ascending: true }),
    'Failed to load clients by email prefix',
  );
  const clientIds = clients.map((client) => client.id);

  info(logger, 'client_prefix_clients_resolved', 'Resolved clients for email prefix', {
    email_prefix: normalizedPrefix,
    matched_client_count: clients.length,
    client_ids: clientIds,
    branch_taken: clients.length > 0 ? 'return_matching_clients' : 'return_no_matching_clients',
    deny_reason: clients.length > 0 ? null : 'no_matching_clients',
  });

  const bookings = clientIds.length === 0
    ? []
    : await requireRows(
      db.from('bookings')
        .select('id, client_id, current_status, starts_at, ends_at')
        .in('client_id', clientIds)
        .order('starts_at', { ascending: true }),
      'Failed to load bookings by client ids',
    );
  const bookingIds = bookings.map((booking) => booking.id);

  info(logger, 'client_prefix_bookings_resolved', 'Resolved bookings for client prefix', {
    email_prefix: normalizedPrefix,
    matched_client_count: clients.length,
    matched_booking_count: bookings.length,
    booking_ids: bookingIds,
    branch_taken: bookings.length > 0 ? 'return_matching_bookings' : 'return_no_matching_bookings',
    deny_reason: bookings.length > 0 ? null : 'no_matching_bookings',
  });

  const payments = bookingIds.length === 0
    ? []
    : await requireRows(
      db.from('payments')
        .select('id, booking_id, status')
        .in('booking_id', bookingIds)
        .order('created_at', { ascending: true }),
      'Failed to load payments by booking ids',
    );
  const contactMessages = clientIds.length === 0
    ? []
    : await requireRows(
      db.from('contact_messages')
        .select('id, client_id, status')
        .in('client_id', clientIds)
        .order('created_at', { ascending: true }),
      'Failed to load contact messages by client ids',
    );
  const reminderSubscriptions = await requireRows(
    db.from('event_reminder_subscriptions')
      .select('id, email, event_family')
      .ilike('email', `${escapedPrefix}%`)
      .order('email', { ascending: true }),
    'Failed to load event reminder subscriptions by email prefix',
  );

  const summary = {
    email_prefix: normalizedPrefix,
    execute,
    matched_client_count: clients.length,
    matched_booking_count: bookings.length,
    matched_payment_count: payments.length,
    matched_contact_message_count: contactMessages.length,
    matched_event_reminder_subscription_count: reminderSubscriptions.length,
    clients,
    bookings,
    payments,
    contact_messages: contactMessages,
    event_reminder_subscriptions: reminderSubscriptions,
    deleted_counts: {
      contact_messages: 0,
      event_reminder_subscriptions: 0,
      payments: 0,
      bookings: 0,
      clients: 0,
    },
  };

  info(logger, 'client_prefix_purge_plan_ready', 'Prepared client-prefix purge plan', {
    email_prefix: normalizedPrefix,
    matched_client_count: clients.length,
    matched_booking_count: bookings.length,
    matched_payment_count: payments.length,
    matched_contact_message_count: contactMessages.length,
    matched_event_reminder_subscription_count: reminderSubscriptions.length,
    branch_taken: execute ? 'execute_client_prefix_purge' : 'return_dry_run_plan',
    deny_reason: execute ? null : 'dry_run_only',
  });

  if (!execute) {
    return summary;
  }

  summary.deleted_counts.contact_messages = await deleteRowsByIds({
    db,
    table: 'contact_messages',
    ids: contactMessages.map((row) => row.id),
    logger,
    emailPrefix: normalizedPrefix,
    deleteBatchSize,
  });
  summary.deleted_counts.event_reminder_subscriptions = await deleteRowsByIds({
    db,
    table: 'event_reminder_subscriptions',
    ids: reminderSubscriptions.map((row) => row.id),
    logger,
    emailPrefix: normalizedPrefix,
    deleteBatchSize,
  });
  summary.deleted_counts.payments = await deleteRowsByIds({
    db,
    table: 'payments',
    ids: payments.map((row) => row.id),
    logger,
    emailPrefix: normalizedPrefix,
    deleteBatchSize,
  });
  summary.deleted_counts.bookings = await deleteRowsByIds({
    db,
    table: 'bookings',
    ids: bookingIds,
    logger,
    emailPrefix: normalizedPrefix,
    deleteBatchSize,
  });
  summary.deleted_counts.clients = await deleteRowsByIds({
    db,
    table: 'clients',
    ids: clientIds,
    logger,
    emailPrefix: normalizedPrefix,
    deleteBatchSize,
  });

  info(logger, 'client_prefix_purge_completed', 'Completed client-prefix purge', {
    email_prefix: normalizedPrefix,
    deleted_contact_message_count: summary.deleted_counts.contact_messages,
    deleted_event_reminder_subscription_count: summary.deleted_counts.event_reminder_subscriptions,
    deleted_payment_count: summary.deleted_counts.payments,
    deleted_booking_count: summary.deleted_counts.bookings,
    deleted_client_count: summary.deleted_counts.clients,
    branch_taken: 'client_prefix_purge_completed',
  });

  return summary;
}
