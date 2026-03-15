#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import {
  createConsoleLogger,
  parseDeleteClientPrefixArgs,
  purgeClientDataByEmailPrefix,
} from './lib/delete-client-prefix.mjs';

const logger = createConsoleLogger();

function printUsage() {
  console.log(`Usage:
  npm run delete:client-prefix -- --email-prefix=<prefix> [--execute]

Behavior:
  Without --execute, the script runs in dry-run mode and prints the rows it would delete.
  With --execute, the script deletes contact messages, event reminder subscriptions,
  payments, bookings, and finally clients for emails matching the prefix.

Required environment:
  SUPABASE_URL
  SUPABASE_SECRET_KEY`);
}

const { emailPrefix, execute, help } = parseDeleteClientPrefixArgs(process.argv.slice(2));

if (help) {
  printUsage();
  process.exit(0);
}

if (!emailPrefix) {
  printUsage();
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();

logger.info({
  source: 'maintenance',
  eventType: 'client_prefix_purge_cli_started',
  message: 'Started client-prefix purge CLI',
  context: {
    execute,
    has_supabase_url: Boolean(supabaseUrl),
    has_supabase_secret_key: Boolean(supabaseSecretKey),
    branch_taken: 'validate_runtime_configuration',
  },
});

if (!supabaseUrl || !supabaseSecretKey) {
  logger.error({
    source: 'maintenance',
    eventType: 'client_prefix_purge_cli_rejected',
    message: 'Missing required Supabase configuration for client-prefix purge CLI',
    context: {
      branch_taken: 'deny_missing_supabase_configuration',
      deny_reason: !supabaseUrl && !supabaseSecretKey
        ? 'supabase_url_and_secret_key_missing'
        : (!supabaseUrl ? 'supabase_url_missing' : 'supabase_secret_key_missing'),
    },
  });
  process.exit(1);
}

const db = createClient(supabaseUrl, supabaseSecretKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

try {
  const summary = await purgeClientDataByEmailPrefix({
    db,
    emailPrefix,
    execute,
    logger,
  });

  console.log(JSON.stringify({
    level: 'info',
    source: 'maintenance',
    eventType: 'client_prefix_purge_cli_summary',
    message: 'Client-prefix purge CLI completed',
    context: summary,
  }, null, 2));
} catch (runError) {
  logger.error({
    source: 'maintenance',
    eventType: 'client_prefix_purge_cli_failed',
    message: runError instanceof Error ? runError.message : 'Unknown client-prefix purge failure',
    context: {
      email_prefix: emailPrefix,
      execute,
      branch_taken: 'unexpected_exception',
    },
  });
  process.exit(1);
}
