#!/usr/bin/env node

import {
  cancelBookingsByClientPrefix,
  parseCancelClientPrefixArgs,
} from './lib/cancel-bookings-by-client-prefix.mjs';
import { createConsoleLogger } from './lib/maintenance-logger.mjs';

const logger = createConsoleLogger();

function printUsage() {
  console.log(`Usage:
  npm run cancel:client-prefix -- --email-prefix=<prefix> [--api-base-url=<url>] [--limit=<n>] [--execute]

Behavior:
  Without --execute, the script calls GET /api/__test/bookings and prints the matched booking count.
  With --execute, the script calls POST /api/__test/bookings/cleanup and prints the cancellation summary.

Runtime configuration:
  API_BASE_URL (optional, defaults to http://127.0.0.1:8787)
  or pass --api-base-url explicitly.`);
}

const {
  apiBaseUrl,
  emailPrefix,
  limit,
  execute,
  help,
} = parseCancelClientPrefixArgs(process.argv.slice(2));

if (help) {
  printUsage();
  process.exit(0);
}

if (!emailPrefix) {
  printUsage();
  process.exit(1);
}

logger.info({
  source: 'maintenance',
  eventType: 'cancel_client_prefix_cli_started',
  message: 'Started cancel-by-client-prefix CLI',
  context: {
    api_base_url: apiBaseUrl,
    email_prefix: emailPrefix,
    batch_limit: limit,
    execute,
    branch_taken: 'validate_cancel_client_prefix_cli_request',
  },
});

try {
  const summary = await cancelBookingsByClientPrefix({
    apiBaseUrl,
    emailPrefix,
    limit,
    execute,
    logger,
  });

  console.log(JSON.stringify({
    level: 'info',
    source: 'maintenance',
    eventType: 'cancel_client_prefix_cli_summary',
    message: execute ? 'Cancel-by-client-prefix CLI completed execution' : 'Cancel-by-client-prefix CLI completed inspection',
    context: summary,
  }, null, 2));
} catch (runError) {
  logger.error({
    source: 'maintenance',
    eventType: 'cancel_client_prefix_cli_failed',
    message: runError instanceof Error ? runError.message : 'Unknown cancel-by-client-prefix failure',
    context: {
      api_base_url: apiBaseUrl,
      email_prefix: emailPrefix,
      batch_limit: limit,
      execute,
      branch_taken: 'unexpected_exception',
    },
  });
  process.exit(1);
}
