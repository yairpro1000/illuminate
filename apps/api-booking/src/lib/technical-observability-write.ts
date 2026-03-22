import type { Env } from '../env.js';
import type { Providers } from '../providers/index.js';
import type { Logger } from './logger.js';
import { operationReferenceFields, type OperationContext } from './execution.js';
import { resolveEmailDispatchState } from './mock-email-preview.js';
import {
  errorMessage,
  errorToDetails,
  sanitizeBody,
  sanitizeHeaders,
  safePathname,
} from '../../../shared/observability/backend.js';
import { safeInsert, safeUpdate } from './technical-observability-core.js';

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
    ...operationReferenceFields(input.operation),
    direction: input.direction,
    provider: input.provider ?? null,
    method: input.method,
    url: input.url,
    request_headers_redacted: sanitizeHeaders(input.requestHeaders) ?? {},
    request_body_preview: sanitizeBody(input.requestBody),
  });
  return inserted?.id ?? null;
}

async function insertCompletedApiLog(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  input: {
    operation: OperationContext;
    direction: 'inbound' | 'outbound';
    provider?: string | null;
    method: string;
    url: string;
    requestHeaders?: HeadersInit | null;
    requestBody?: unknown;
    responseStatus?: number | null;
    responseHeaders?: HeadersInit | null;
    responseBody?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    startedAtMs: number;
  },
): Promise<string | null> {
  const inserted = await safeInsert(env, 'api_logs', {
    app_area: input.operation.appArea,
    request_id: input.operation.requestId,
    correlation_id: input.operation.correlationId,
    ...operationReferenceFields(input.operation),
    direction: input.direction,
    provider: input.provider ?? null,
    method: input.method,
    url: input.url,
    request_headers_redacted: sanitizeHeaders(input.requestHeaders) ?? {},
    request_body_preview: sanitizeBody(input.requestBody),
    completed_at: new Date().toISOString(),
    response_status: input.responseStatus ?? null,
    response_headers_redacted: sanitizeHeaders(input.responseHeaders) ?? {},
    response_body_preview: sanitizeBody(input.responseBody),
    duration_ms: Math.max(0, Date.now() - input.startedAtMs),
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ?? null,
  });
  return inserted?.id ?? null;
}

export async function finalizeApiLog(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  apiLogId: string | null,
  input: {
    operation?: OperationContext;
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
    ...(input.operation ? operationReferenceFields(input.operation) : {}),
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
    ...operationReferenceFields(operation),
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

  logger.logInfo({
    source: 'provider',
    eventType: 'provider_wrapper_started',
    message: 'Provider call entered shared outbound wrapper',
    context: {
      provider: input.provider,
      provider_operation: input.operationName,
      branch_taken: 'execute_provider_call_via_shared_wrapper',
      outbound_api_log_write_mode: 'insert_completed_row_after_provider_call',
    },
  });

  try {
    const result = await run();
    const apiLogId = await insertCompletedApiLog(env, {
      operation,
      direction: 'outbound',
      provider: input.provider,
      method: input.operationName,
      url,
      requestBody: { args: input.args },
      responseStatus: 200,
      responseBody: result,
      startedAtMs,
    });
    operation.latestProviderApiLogId = apiLogId;
    logger.logInfo({
      source: 'provider',
      eventType: 'provider_wrapper_completed',
      message: 'Provider call completed through shared outbound wrapper',
      context: {
        provider: input.provider,
        provider_operation: input.operationName,
        api_log_id: apiLogId,
        status_code: 200,
        branch_taken: 'provider_call_succeeded',
        deny_reason: null,
      },
    });
    return result;
  } catch (error) {
    const statusCode = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : null;
    const errorCode = typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : null;
    const errorText = errorMessage(error);
    const apiLogId = await insertCompletedApiLog(env, {
      operation,
      direction: 'outbound',
      provider: input.provider,
      method: input.operationName,
      url,
      requestBody: { args: input.args },
      responseStatus: statusCode,
      responseBody: null,
      errorCode,
      errorMessage: errorText,
      startedAtMs,
    });
    operation.latestProviderApiLogId = apiLogId;
    logger.logWarn({
      source: 'provider',
      eventType: 'provider_wrapper_failed',
      message: 'Provider call failed in shared outbound wrapper',
      context: {
        provider: input.provider,
        provider_operation: input.operationName,
        api_log_id: apiLogId,
        status_code: statusCode,
        error_code: errorCode,
        branch_taken: 'provider_call_failed',
        deny_reason: errorText,
      },
    });
    throw error;
  }
}

export async function syncApiLogOperationReferences(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  apiLogId: string | null,
  operation: OperationContext | undefined,
): Promise<void> {
  if (!apiLogId || !operation) return;
  await safeUpdate(env, 'api_logs', apiLogId, operationReferenceFields(operation));
}

export function wrapProvidersForOperation(
  providers: Providers,
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY' | 'OBSERVABILITY_SCHEMA'>,
  logger: Logger,
  operation: OperationContext,
  options: {
    emailPreviewContext?: {
      emailMode: string;
      apiOrigin: string;
      request: Request;
    };
  } = {},
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
            async () => {
              const result = await value.apply(innerTarget, args);
              if (providerName === 'email' && options.emailPreviewContext) {
                operation.latestEmailDispatch = resolveEmailDispatchState(
                  result as { messageId?: string; debug?: Record<string, unknown> } | null | undefined,
                  options.emailPreviewContext,
                );
              }
              return result;
            },
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
