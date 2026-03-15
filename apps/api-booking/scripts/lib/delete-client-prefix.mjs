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

async function loadRowsByAnyForeignKey({
  db,
  table,
  select,
  queries,
  failureMessage,
}) {
  const rowsById = new Map();
  for (const query of queries) {
    if (query.ids.length === 0) continue;
    const rows = await requireRows(
      db.from(table)
        .select(select)
        .in(query.column, query.ids),
      failureMessage,
    );
    for (const row of rows) {
      if (typeof row.id === 'string' && !rowsById.has(row.id)) {
        rowsById.set(row.id, row);
      }
    }
  }
  return Array.from(rowsById.values());
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
  const bookingEvents = bookingIds.length === 0
    ? []
    : await requireRows(
      db.from('booking_events')
        .select('id, booking_id, event_type, created_at')
        .in('booking_id', bookingIds)
        .order('created_at', { ascending: true }),
      'Failed to load booking events by booking ids',
    );
  const bookingEventIds = bookingEvents.map((bookingEvent) => bookingEvent.id);

  info(logger, 'client_prefix_booking_events_resolved', 'Resolved booking events for client prefix', {
    email_prefix: normalizedPrefix,
    matched_booking_count: bookings.length,
    matched_booking_event_count: bookingEvents.length,
    booking_event_ids: bookingEventIds,
    branch_taken: bookingEvents.length > 0 ? 'return_matching_booking_events' : 'return_no_matching_booking_events',
    deny_reason: bookingEvents.length > 0 ? null : 'no_matching_booking_events',
  });

  const bookingSideEffects = bookingEventIds.length === 0
    ? []
    : await requireRows(
      db.from('booking_side_effects')
        .select('id, booking_event_id, effect_intent, status')
        .in('booking_event_id', bookingEventIds)
        .order('created_at', { ascending: true }),
      'Failed to load booking side effects by booking event ids',
    );
  const bookingSideEffectIds = bookingSideEffects.map((sideEffect) => sideEffect.id);

  info(logger, 'client_prefix_booking_side_effects_resolved', 'Resolved booking side effects for client prefix', {
    email_prefix: normalizedPrefix,
    matched_booking_event_count: bookingEvents.length,
    matched_booking_side_effect_count: bookingSideEffects.length,
    booking_side_effect_ids: bookingSideEffectIds,
    branch_taken: bookingSideEffects.length > 0 ? 'return_matching_booking_side_effects' : 'return_no_matching_booking_side_effects',
    deny_reason: bookingSideEffects.length > 0 ? null : 'no_matching_booking_side_effects',
  });

  const bookingSideEffectAttempts = bookingSideEffectIds.length === 0
    ? []
    : await requireRows(
      db.from('booking_side_effect_attempts')
        .select('id, booking_side_effect_id, status')
        .in('booking_side_effect_id', bookingSideEffectIds)
        .order('created_at', { ascending: true }),
      'Failed to load booking side effect attempts by side effect ids',
    );
  const bookingSideEffectAttemptIds = bookingSideEffectAttempts.map((attempt) => attempt.id);

  info(logger, 'client_prefix_booking_side_effect_attempts_resolved', 'Resolved booking side effect attempts for client prefix', {
    email_prefix: normalizedPrefix,
    matched_booking_side_effect_count: bookingSideEffects.length,
    matched_booking_side_effect_attempt_count: bookingSideEffectAttempts.length,
    booking_side_effect_attempt_ids: bookingSideEffectAttemptIds,
    branch_taken: bookingSideEffectAttempts.length > 0 ? 'return_matching_booking_side_effect_attempts' : 'return_no_matching_booking_side_effect_attempts',
    deny_reason: bookingSideEffectAttempts.length > 0 ? null : 'no_matching_booking_side_effect_attempts',
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
  const apiLogs = await loadRowsByAnyForeignKey({
    db,
    table: 'api_logs',
    select: 'id, booking_id, booking_event_id, side_effect_id, side_effect_attempt_id',
    queries: [
      { column: 'booking_id', ids: bookingIds },
      { column: 'booking_event_id', ids: bookingEventIds },
      { column: 'side_effect_id', ids: bookingSideEffectIds },
      { column: 'side_effect_attempt_id', ids: bookingSideEffectAttemptIds },
    ],
    failureMessage: 'Failed to load api logs by booking dependency ids',
  });
  const apiLogIds = apiLogs.map((apiLog) => apiLog.id);

  const exceptionLogs = await loadRowsByAnyForeignKey({
    db,
    table: 'exception_logs',
    select: 'id, booking_id, booking_event_id, side_effect_id, side_effect_attempt_id',
    queries: [
      { column: 'booking_id', ids: bookingIds },
      { column: 'booking_event_id', ids: bookingEventIds },
      { column: 'side_effect_id', ids: bookingSideEffectIds },
      { column: 'side_effect_attempt_id', ids: bookingSideEffectAttemptIds },
    ],
    failureMessage: 'Failed to load exception logs by booking dependency ids',
  });
  const exceptionLogIds = exceptionLogs.map((exceptionLog) => exceptionLog.id);

  info(logger, 'client_prefix_observability_rows_resolved', 'Resolved observability rows for client prefix', {
    email_prefix: normalizedPrefix,
    matched_api_log_count: apiLogs.length,
    matched_exception_log_count: exceptionLogs.length,
    api_log_ids: apiLogIds,
    exception_log_ids: exceptionLogIds,
    branch_taken: (apiLogs.length > 0 || exceptionLogs.length > 0)
      ? 'return_matching_observability_rows'
      : 'return_no_matching_observability_rows',
    deny_reason: (apiLogs.length > 0 || exceptionLogs.length > 0) ? null : 'no_matching_observability_rows',
  });

  const summary = {
    email_prefix: normalizedPrefix,
    execute,
    matched_client_count: clients.length,
    matched_booking_count: bookings.length,
    matched_booking_event_count: bookingEvents.length,
    matched_booking_side_effect_count: bookingSideEffects.length,
    matched_booking_side_effect_attempt_count: bookingSideEffectAttempts.length,
    matched_payment_count: payments.length,
    matched_contact_message_count: contactMessages.length,
    matched_event_reminder_subscription_count: reminderSubscriptions.length,
    matched_api_log_count: apiLogs.length,
    matched_exception_log_count: exceptionLogs.length,
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
    deleted_counts: {
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
    },
  };

  info(logger, 'client_prefix_purge_plan_ready', 'Prepared client-prefix purge plan', {
    email_prefix: normalizedPrefix,
    matched_client_count: clients.length,
    matched_booking_count: bookings.length,
    matched_booking_event_count: bookingEvents.length,
    matched_booking_side_effect_count: bookingSideEffects.length,
    matched_booking_side_effect_attempt_count: bookingSideEffectAttempts.length,
    matched_payment_count: payments.length,
    matched_contact_message_count: contactMessages.length,
    matched_event_reminder_subscription_count: reminderSubscriptions.length,
    matched_api_log_count: apiLogs.length,
    matched_exception_log_count: exceptionLogs.length,
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
  summary.deleted_counts.api_logs = await deleteRowsByIds({
    db,
    table: 'api_logs',
    ids: apiLogIds,
    logger,
    emailPrefix: normalizedPrefix,
    deleteBatchSize,
  });
  summary.deleted_counts.exception_logs = await deleteRowsByIds({
    db,
    table: 'exception_logs',
    ids: exceptionLogIds,
    logger,
    emailPrefix: normalizedPrefix,
    deleteBatchSize,
  });
  summary.deleted_counts.booking_side_effect_attempts = await deleteRowsByIds({
    db,
    table: 'booking_side_effect_attempts',
    ids: bookingSideEffectAttemptIds,
    logger,
    emailPrefix: normalizedPrefix,
    deleteBatchSize,
  });
  summary.deleted_counts.booking_side_effects = await deleteRowsByIds({
    db,
    table: 'booking_side_effects',
    ids: bookingSideEffectIds,
    logger,
    emailPrefix: normalizedPrefix,
    deleteBatchSize,
  });
  summary.deleted_counts.booking_events = await deleteRowsByIds({
    db,
    table: 'booking_events',
    ids: bookingEventIds,
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
    deleted_api_log_count: summary.deleted_counts.api_logs,
    deleted_exception_log_count: summary.deleted_counts.exception_logs,
    deleted_booking_side_effect_attempt_count: summary.deleted_counts.booking_side_effect_attempts,
    deleted_booking_side_effect_count: summary.deleted_counts.booking_side_effects,
    deleted_booking_event_count: summary.deleted_counts.booking_events,
    deleted_payment_count: summary.deleted_counts.payments,
    deleted_booking_count: summary.deleted_counts.bookings,
    deleted_client_count: summary.deleted_counts.clients,
    branch_taken: 'client_prefix_purge_completed',
  });

  return summary;
}
