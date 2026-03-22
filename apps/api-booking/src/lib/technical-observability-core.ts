import type { Env } from '../env.js';
import { makeSupabase, type Db } from '../repo/supabase.js';

type TechnicalDb = ReturnType<Db['schema']>;
export type TechnicalTable = 'api_logs' | 'exception_logs';

export interface TechnicalObservabilityRow {
  id: string;
  created_at: string;
  [key: string]: unknown;
}

let cachedDb: Db | null = null;
const emittedWarnings = new Set<string>();

function getDb(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY'>): Db {
  if (!cachedDb) cachedDb = makeSupabase(env);
  return cachedDb;
}

function warnOnce(key: string, message: string, details: Record<string, unknown>): void {
  if (emittedWarnings.has(key)) return;
  emittedWarnings.add(key);
  console.warn(message, details);
}

export function getSchema(env: Pick<Env, 'OBSERVABILITY_SCHEMA'>): string {
  return env.OBSERVABILITY_SCHEMA?.trim() || 'public';
}

function shouldDisableDbPersistence(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY'>): boolean {
  const url = String(env.SUPABASE_URL ?? '').trim();
  const key = String(env.SUPABASE_SECRET_KEY ?? '').trim();
  if (!url || !key) return true;

  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('.local') || host.endsWith('.example');
  } catch {
    return true;
  }
}

function tableClients(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
): Array<{ schema: string; client: TechnicalDb }> {
  if (shouldDisableDbPersistence(env)) {
    warnOnce('persistence_disabled:missing_or_local_supabase_configuration', '[technical-observability] persistence disabled', {
      reason: 'missing_or_local_supabase_configuration',
    });
    return [];
  }

  const configuredSchema = getSchema(env);
  const schemas = Array.from(new Set([configuredSchema, 'public']));
  const db = getDb(env);
  return schemas.map((schema) => ({
    schema,
    client: db.schema(schema),
  }));
}

export async function safeInsert(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  table: TechnicalTable,
  row: Record<string, unknown>,
): Promise<{ id: string } | null> {
  const clients = tableClients(env);
  if (clients.length === 0) return null;

  let lastError: string | null = null;
  for (const { schema, client } of clients) {
    try {
      const { data, error } = await client.from(table).insert(row).select('id').single<{ id: string }>();
      if (error) {
        lastError = error.message;
        console.warn('[technical-observability] insert failed', { schema, table, error: error.message });
        continue;
      }
      if (schema !== getSchema(env)) {
        console.warn('[technical-observability] insert recovered via fallback schema', {
          table,
          configured_schema: getSchema(env),
          fallback_schema: schema,
        });
      }
      return data ?? null;
    } catch (error) {
      lastError = String(error);
      console.warn('[technical-observability] insert failed', { schema, table, error: lastError });
    }
  }

  console.warn('[technical-observability] insert exhausted schemas', {
    table,
    configured_schema: getSchema(env),
    last_error: lastError,
  });
  return null;
}

export async function safeUpdate(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  table: 'api_logs',
  id: string,
  row: Record<string, unknown>,
): Promise<void> {
  const clients = tableClients(env);
  if (clients.length === 0) return;

  let lastError: string | null = null;
  for (const { schema, client } of clients) {
    try {
      const { data, error } = await client
        .from(table)
        .update(row)
        .eq('id', id)
        .select('id')
        .maybeSingle<{ id: string }>();
      if (error) {
        lastError = error.message;
        console.warn('[technical-observability] update failed', { schema, table, id, error: error.message });
        continue;
      }
      if (!data?.id) {
        lastError = 'api_log_row_not_found_in_schema';
        console.warn('[technical-observability] update target row missing', {
          schema,
          table,
          id,
          configured_schema: getSchema(env),
          branch_taken: 'skip_schema_update_row_missing',
          deny_reason: 'api_log_row_not_found_in_schema',
        });
        continue;
      }
      if (schema !== getSchema(env)) {
        console.warn('[technical-observability] update recovered via fallback schema', {
          table,
          id,
          configured_schema: getSchema(env),
          fallback_schema: schema,
        });
      }
      return;
    } catch (error) {
      lastError = String(error);
      console.warn('[technical-observability] update failed', { schema, table, id, error: lastError });
    }
  }

  console.warn('[technical-observability] update exhausted schemas', {
    table,
    id,
    configured_schema: getSchema(env),
    last_error: lastError,
  });
}

export async function safeSelectMany(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  table: TechnicalTable,
  run: (client: TechnicalDb) => Promise<{ data: TechnicalObservabilityRow[] | null; error: { message: string } | null }>,
): Promise<TechnicalObservabilityRow[]> {
  const clients = tableClients(env);
  if (clients.length === 0) return [];

  let lastError: string | null = null;
  for (const { schema, client } of clients) {
    try {
      const { data, error } = await run(client);
      if (error) {
        lastError = error.message;
        console.warn('[technical-observability] select failed', { schema, table, error: error.message });
        continue;
      }
      if (schema !== getSchema(env)) {
        console.warn('[technical-observability] select recovered via fallback schema', {
          table,
          configured_schema: getSchema(env),
          fallback_schema: schema,
        });
      }
      return data ?? [];
    } catch (error) {
      lastError = String(error);
      console.warn('[technical-observability] select failed', { schema, table, error: lastError });
    }
  }

  console.warn('[technical-observability] select exhausted schemas', {
    table,
    configured_schema: getSchema(env),
    last_error: lastError,
  });
  return [];
}

export function dedupeTechnicalRows(rows: TechnicalObservabilityRow[]): TechnicalObservabilityRow[] {
  const deduped = new Map<string, TechnicalObservabilityRow>();
  for (const row of rows) deduped.set(String(row.id), row);
  return [...deduped.values()].sort((left, right) =>
    new Date(String(left.created_at)).getTime() - new Date(String(right.created_at)).getTime(),
  );
}

export async function selectTechnicalRowsByEq(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  table: TechnicalTable,
  column: 'booking_id' | 'booking_event_id' | 'side_effect_id' | 'side_effect_attempt_id',
  value: string,
): Promise<TechnicalObservabilityRow[]> {
  return safeSelectMany(env, table, async (client) =>
    await client.from(table).select('*').eq(column, value).order('created_at', { ascending: true }),
  );
}

export async function selectTechnicalRowsByIn(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  table: TechnicalTable,
  column: 'booking_event_id' | 'side_effect_id' | 'side_effect_attempt_id',
  values: string[],
): Promise<TechnicalObservabilityRow[]> {
  if (values.length === 0) return [];
  return safeSelectMany(env, table, async (client) =>
    await client.from(table).select('*').in(column, values).order('created_at', { ascending: true }),
  );
}
