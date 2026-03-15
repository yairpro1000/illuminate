import { normalizeLowercasePrefix } from '../../src/lib/prefix-utils.js';
import { createConsoleLogger } from './maintenance-logger.mjs';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_CLEANUP_LIMIT = 10;
const MAX_CLEANUP_LIMIT = 10;
const SEQUENTIAL_REQUEST_LIMIT = 1;
const TERMINAL_BOOKING_STATUSES = new Set(['CANCELED', 'EXPIRED', 'COMPLETED', 'NO_SHOW']);

function info(logger, eventType, message, context) {
  logger.info({ source: 'maintenance', eventType, message, context });
}

function warn(logger, eventType, message, context) {
  logger.warn({ source: 'maintenance', eventType, message, context });
}

function normalizeCleanupLimit(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return Math.min(value, MAX_CLEANUP_LIMIT);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return Math.min(parsed, MAX_CLEANUP_LIMIT);
      }
    }
  }
  return DEFAULT_CLEANUP_LIMIT;
}

export function parseCancelClientPrefixArgs(argv, env = process.env) {
  let apiBaseUrl = env.API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  let emailPrefix = null;
  let limit = DEFAULT_CLEANUP_LIMIT;
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
    if (arg.startsWith('--api-base-url=')) {
      apiBaseUrl = arg.slice('--api-base-url='.length).trim() || DEFAULT_API_BASE_URL;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      limit = normalizeCleanupLimit(arg.slice('--limit='.length));
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
    apiBaseUrl,
    emailPrefix,
    limit,
    execute,
    help,
  };
}

function normalizeApiBaseUrl(apiBaseUrl) {
  const normalized = apiBaseUrl?.trim().replace(/\/+$/, '') ?? '';
  return normalized || DEFAULT_API_BASE_URL;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response but received: ${text}`);
  }
}

async function fetchJsonOrThrow({ url, init, failureMessage, logger, eventType, context, fetchImpl }) {
  info(logger, `${eventType}_started`, `Started ${eventType.replaceAll('_', ' ')}`, {
    ...context,
    branch_taken: `fetch_${eventType}`,
  });

  const response = await fetchImpl(url, init);
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    const message = payload?.message || payload?.error || response.statusText || 'request_failed';
    warn(logger, `${eventType}_failed`, `Failed ${eventType.replaceAll('_', ' ')}`, {
      ...context,
      status_code: response.status,
      branch_taken: `deny_${eventType}`,
      deny_reason: message,
    });
    throw new Error(`${failureMessage}: ${message}`);
  }

  info(logger, `${eventType}_completed`, `Completed ${eventType.replaceAll('_', ' ')}`, {
    ...context,
    status_code: response.status,
    branch_taken: `return_${eventType}`,
  });

  return payload;
}

function isTerminalBookingStatus(status) {
  return TERMINAL_BOOKING_STATUSES.has(String(status ?? '').toUpperCase());
}

function summarizeInspectionBookings(bookings) {
  const rows = Array.isArray(bookings) ? bookings : [];
  const active = [];
  const terminal = [];

  for (const row of rows) {
    if (isTerminalBookingStatus(row.status)) {
      terminal.push(row);
      continue;
    }
    active.push(row);
  }

  return {
    matchedCount: rows.length,
    activeBookings: active,
    terminalBookings: terminal,
  };
}

function pushUniqueRows(target, rows, keyField = 'booking_id') {
  const seen = new Set(target.map((row) => row?.[keyField]).filter(Boolean));
  for (const row of rows) {
    const key = row?.[keyField];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    target.push(row);
  }
}

export async function inspectBookingsByClientPrefix({
  apiBaseUrl,
  emailPrefix,
  logger = createConsoleLogger(),
  fetchImpl = fetch,
}) {
  const normalizedPrefix = normalizeLowercasePrefix(emailPrefix);

  info(logger, 'cancel_client_prefix_inspection_started', 'Started booking cleanup inspection by client prefix', {
    api_base_url: normalizeApiBaseUrl(apiBaseUrl),
    email_prefix_raw: emailPrefix ?? null,
    branch_taken: 'validate_cancel_client_prefix_inspection_request',
  });

  if (!normalizedPrefix) {
    warn(logger, 'cancel_client_prefix_inspection_rejected', 'Rejected booking cleanup inspection because email prefix was missing', {
      branch_taken: 'deny_missing_email_prefix',
      deny_reason: 'email_prefix_missing',
    });
    throw new Error('email prefix is required');
  }

  const normalizedBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const url = new URL('/api/__test/bookings', normalizedBaseUrl);
  url.searchParams.set('email_prefix', normalizedPrefix);

  return fetchJsonOrThrow({
    url: url.toString(),
    init: { method: 'GET' },
    failureMessage: 'Failed to inspect bookings by client prefix',
    logger,
    eventType: 'cancel_client_prefix_inspection_request',
    context: {
      api_base_url: normalizedBaseUrl,
      email_prefix: normalizedPrefix,
    },
    fetchImpl,
  });
}

export async function cancelBookingsByClientPrefix({
  apiBaseUrl,
  emailPrefix,
  limit = DEFAULT_CLEANUP_LIMIT,
  execute = false,
  logger = createConsoleLogger(),
  fetchImpl = fetch,
}) {
  if (!execute) {
    return inspectBookingsByClientPrefix({
      apiBaseUrl,
      emailPrefix,
      logger,
      fetchImpl,
    });
  }

  const normalizedPrefix = normalizeLowercasePrefix(emailPrefix);
  const normalizedLimit = normalizeCleanupLimit(limit);

  info(logger, 'cancel_client_prefix_cleanup_started', 'Started booking cleanup execution by client prefix', {
    api_base_url: normalizeApiBaseUrl(apiBaseUrl),
    email_prefix_raw: emailPrefix ?? null,
    batch_limit: normalizedLimit,
    branch_taken: 'validate_cancel_client_prefix_cleanup_request',
  });

  if (!normalizedPrefix) {
    warn(logger, 'cancel_client_prefix_cleanup_rejected', 'Rejected booking cleanup execution because email prefix was missing', {
      branch_taken: 'deny_missing_email_prefix',
      deny_reason: 'email_prefix_missing',
    });
    throw new Error('email prefix is required');
  }

  const normalizedBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const inspection = await inspectBookingsByClientPrefix({
    apiBaseUrl: normalizedBaseUrl,
    emailPrefix: normalizedPrefix,
    logger,
    fetchImpl,
  });

  const inspectionSummary = summarizeInspectionBookings(inspection?.bookings);
  const targetProcessCount = Math.min(inspectionSummary.activeBookings.length, normalizedLimit);
  const cleanupUrl = new URL('/api/__test/bookings/cleanup', normalizedBaseUrl);
  const aggregate = {
    email_prefix: normalizedPrefix,
    matched_count: inspectionSummary.matchedCount,
    active_matched_count: inspectionSummary.activeBookings.length,
    processed_count: 0,
    remaining_active_count: inspectionSummary.activeBookings.length,
    batch_limit: normalizedLimit,
    per_request_limit: SEQUENTIAL_REQUEST_LIMIT,
    canceled_count: 0,
    skipped_count: inspectionSummary.terminalBookings.length,
    failed_count: 0,
    canceled: [],
    skipped: inspectionSummary.terminalBookings.map((row) => ({
      booking_id: row.booking_id,
      status: row.status,
      reason: 'already_terminal',
    })),
    failed: [],
  };

  info(logger, 'cancel_client_prefix_cleanup_plan_ready', 'Prepared sequential booking cleanup plan by client prefix', {
    api_base_url: normalizedBaseUrl,
    email_prefix: normalizedPrefix,
    matched_count: aggregate.matched_count,
    active_matched_count: aggregate.active_matched_count,
    requested_cleanup_limit: normalizedLimit,
    per_request_limit: SEQUENTIAL_REQUEST_LIMIT,
    branch_taken: targetProcessCount > 0 ? 'execute_sequential_cleanup_iterations' : 'return_no_active_bookings',
    deny_reason: targetProcessCount > 0 ? null : 'no_active_bookings',
  });

  for (let iterationIndex = 0; iterationIndex < targetProcessCount; iterationIndex += 1) {
    info(logger, 'cancel_client_prefix_cleanup_iteration_started', 'Started sequential booking cleanup iteration', {
      api_base_url: normalizedBaseUrl,
      email_prefix: normalizedPrefix,
      iteration_index: iterationIndex + 1,
      iteration_target_count: targetProcessCount,
      processed_count_so_far: aggregate.processed_count,
      branch_taken: 'execute_single_cleanup_request',
    });

    const iterationSummary = await fetchJsonOrThrow({
      url: cleanupUrl.toString(),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_prefix: normalizedPrefix,
          limit: SEQUENTIAL_REQUEST_LIMIT,
        }),
      },
      failureMessage: 'Failed to cancel bookings by client prefix',
      logger,
      eventType: 'cancel_client_prefix_cleanup_request',
      context: {
        api_base_url: normalizedBaseUrl,
        email_prefix: normalizedPrefix,
        batch_limit: normalizedLimit,
        per_request_limit: SEQUENTIAL_REQUEST_LIMIT,
        iteration_index: iterationIndex + 1,
      },
      fetchImpl,
    });

    aggregate.processed_count += Number(iterationSummary?.processed_count ?? 0);
    aggregate.remaining_active_count = Number(iterationSummary?.remaining_active_count ?? aggregate.remaining_active_count);
    pushUniqueRows(aggregate.canceled, iterationSummary?.canceled ?? []);
    pushUniqueRows(aggregate.skipped, iterationSummary?.skipped ?? []);
    pushUniqueRows(aggregate.failed, iterationSummary?.failed ?? []);
    aggregate.canceled_count = aggregate.canceled.length;
    aggregate.skipped_count = aggregate.skipped.length;
    aggregate.failed_count = aggregate.failed.length;

    const branchTaken = aggregate.failed_count > 0
      ? 'stop_after_iteration_failure'
      : (aggregate.remaining_active_count > 0 ? 'continue_next_iteration' : 'cleanup_completed_no_remaining_active_bookings');

    info(logger, 'cancel_client_prefix_cleanup_iteration_completed', 'Completed sequential booking cleanup iteration', {
      api_base_url: normalizedBaseUrl,
      email_prefix: normalizedPrefix,
      iteration_index: iterationIndex + 1,
      iteration_target_count: targetProcessCount,
      processed_count: aggregate.processed_count,
      remaining_active_count: aggregate.remaining_active_count,
      canceled_count: aggregate.canceled_count,
      failed_count: aggregate.failed_count,
      branch_taken: branchTaken,
      deny_reason: aggregate.failed_count > 0 ? 'iteration_reported_failed_bookings' : null,
    });

    if (aggregate.failed_count > 0 || aggregate.remaining_active_count <= 0) {
      break;
    }
  }

  return aggregate;
}
