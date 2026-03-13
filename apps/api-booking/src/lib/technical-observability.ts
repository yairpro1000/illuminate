import type { Env } from '../env.js';
import type { Providers } from '../providers/index.js';
import type { Logger } from './logger.js';
import type { OperationContext } from './execution.js';
import { makeSupabase, type Db } from '../repo/supabase.js';
import {
  errorMessage,
  errorToDetails,
  sanitizeBody,
  sanitizeHeaders,
  safePathname,
} from '../../../shared/observability/backend.js';

type TechnicalDb = ReturnType<Db['schema']>;

let cachedDb: Db | null = null;

function getDb(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY'>): Db {
  if (!cachedDb) cachedDb = makeSupabase(env);
  return cachedDb;
}

function getSchema(env: Pick<Env, 'OBSERVABILITY_SCHEMA'>): string {
  return env.OBSERVABILITY_SCHEMA?.trim() || 'observability';
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

function tableClient(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>): TechnicalDb | null {
  if (shouldDisableDbPersistence(env)) return null;
  return getDb(env).schema(getSchema(env));
}

async function safeInsert(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  table: 'api_logs' | 'exception_logs',
  row: Record<string, unknown>,
): Promise<{ id: string } | null> {
  const client = tableClient(env);
  if (!client) return null;

  try {
    const { data, error } = await client.from(table).insert(row).select('id').single<{ id: string }>();
    if (error) {
      console.warn('[technical-observability] insert failed', { table, error: error.message });
      return null;
    }
    return data ?? null;
  } catch (error) {
    console.warn('[technical-observability] insert failed', { table, error: String(error) });
    return null;
  }
}

async function safeUpdate(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  table: 'api_logs',
  id: string,
  row: Record<string, unknown>,
): Promise<void> {
  const client = tableClient(env);
  if (!client) return;

  try {
    const { error } = await client.from(table).update(row).eq('id', id);
    if (error) {
      console.warn('[technical-observability] update failed', { table, id, error: error.message });
    }
  } catch (error) {
    console.warn('[technical-observability] update failed', { table, id, error: String(error) });
  }
}

export async function startApiLog(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  input: {
    operation: OperationContext;
    direction: 'inbound' | 'outbound';
    provider?: string | null;
    method: string;
    url: string;
    requestHeaders?: HeadersInit | null;
    requestBody?: unknown;
  },
): Promise<string | null> {
  const inserted = await safeInsert(env, 'api_logs', {
    app_area: input.operation.appArea,
    request_id: input.operation.requestId,
    correlation_id: input.operation.correlationId,
    booking_id: input.operation.bookingId,
    booking_event_id: input.operation.bookingEventId,
    side_effect_id: input.operation.sideEffectId,
    side_effect_attempt_id: input.operation.sideEffectAttemptId,
    direction: input.direction,
    provider: input.provider ?? null,
    method: input.method,
    url: input.url,
    request_headers_redacted: sanitizeHeaders(input.requestHeaders) ?? {},
    request_body_preview: sanitizeBody(input.requestBody),
  });
  return inserted?.id ?? null;
}

export async function finalizeApiLog(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  apiLogId: string | null,
  input: {
    responseStatus?: number | null;
    responseHeaders?: HeadersInit | null;
    responseBody?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    startedAtMs: number;
  },
): Promise<void> {
  if (!apiLogId) return;

  await safeUpdate(env, 'api_logs', apiLogId, {
    completed_at: new Date().toISOString(),
    response_status: input.responseStatus ?? null,
    response_headers_redacted: sanitizeHeaders(input.responseHeaders) ?? {},
    response_body_preview: sanitizeBody(input.responseBody),
    duration_ms: Math.max(0, Date.now() - input.startedAtMs),
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
  });
}

export async function recordExceptionLog(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  operation: OperationContext,
  error: unknown,
  contextJson: Record<string, unknown>,
  errorCode?: string | null,
): Promise<void> {
  const details = errorToDetails(error);
  await safeInsert(env, 'exception_logs', {
    app_area: operation.appArea,
    request_id: operation.requestId,
    correlation_id: operation.correlationId,
    booking_id: operation.bookingId,
    booking_event_id: operation.bookingEventId,
    side_effect_id: operation.sideEffectId,
    side_effect_attempt_id: operation.sideEffectAttemptId,
    error_type: details.errorName ?? 'UnknownError',
    error_code: errorCode ?? null,
    message: errorMessage(error),
    stack_trace: details.stackTrace ?? null,
    context_json: contextJson,
  });
}

export async function withOutboundProviderCall<T>(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  logger: Logger,
  operation: OperationContext,
  input: {
    provider: string;
    operationName: string;
    args: unknown[];
  },
  run: () => Promise<T>,
): Promise<T> {
  const startedAtMs = Date.now();
  const url = `provider://${input.provider}/${input.operationName}`;
  const apiLogId = await startApiLog(env, {
    operation,
    direction: 'outbound',
    provider: input.provider,
    method: input.operationName,
    url,
    requestBody: { args: input.args },
  });
  operation.latestProviderApiLogId = apiLogId;

  logger.logInfo({
    source: 'provider',
    eventType: 'provider_wrapper_started',
    message: 'Provider call entered shared outbound wrapper',
    context: {
      provider: input.provider,
      provider_operation: input.operationName,
      api_log_id: apiLogId,
      branch_taken: 'execute_provider_call_via_shared_wrapper',
    },
  });

  try {
    const result = await run();
    await finalizeApiLog(env, apiLogId, {
      responseStatus: 200,
      responseBody: result,
      startedAtMs,
    });
    operation.latestProviderApiLogId = apiLogId;
    return result;
  } catch (error) {
    await finalizeApiLog(env, apiLogId, {
      responseStatus: typeof (error as { status?: unknown })?.status === 'number'
        ? (error as { status: number }).status
        : null,
      responseBody: null,
      errorCode: typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : null,
      errorMessage: errorMessage(error),
      startedAtMs,
    });
    operation.latestProviderApiLogId = apiLogId;
    throw error;
  }
}

export function wrapProvidersForOperation(
  providers: Providers,
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  logger: Logger,
  operation: OperationContext,
): Providers {
  function wrapGroup<T extends object>(providerName: string, target: T): T {
    if ((!target || (typeof target !== 'object' && typeof target !== 'function')) as boolean) {
      return target;
    }
    return new Proxy(target, {
      get(innerTarget, prop, receiver) {
        const value = Reflect.get(innerTarget, prop, receiver);
        if (typeof value !== 'function') return value;

        return (...args: unknown[]) =>
          withOutboundProviderCall(
            env,
            logger,
            operation,
            {
              provider: providerName,
              operationName: String(prop),
              args,
            },
            async () => value.apply(innerTarget, args),
          );
      },
    }) as T;
  }

  return {
    ...providers,
    email: wrapGroup('email', providers.email),
    calendar: wrapGroup('calendar', providers.calendar),
    payments: wrapGroup('payments', providers.payments),
    antibot: wrapGroup('antibot', providers.antibot),
  };
}

export function responseUrl(request: Request): string {
  return safePathname(request.url);
}
