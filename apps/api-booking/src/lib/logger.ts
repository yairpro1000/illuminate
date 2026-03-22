import type { Env } from '../env.js';
import {
  errorMessage,
  errorToDetails,
  sanitizeContext,
  type JsonValue,
  type LogSource,
} from '../../../shared/observability/backend.js';

type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  source?: LogSource;
  eventType: string;
  message?: string | null;
  error?: unknown;
  context?: Record<string, JsonValue>;
}

interface LoggerDefaults {
  source: LogSource;
  requestId: string;
  correlationId: string;
  route?: string | null;
  context?: Record<string, JsonValue>;
}

export interface Logger {
  logInfo(entry: LogEntry): void;
  logWarn(entry: LogEntry): void;
  logError(entry: LogEntry): void;
  captureException(entry: LogEntry): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  logRequest(entry: {
    method: string;
    url: string;
    path: string;
    statusCode: number;
    durationMs: number;
    success: boolean;
    requestSizeBytes?: number | null;
    responseSizeBytes?: number | null;
  }): void;
  logMilestone(eventType: string, context?: Record<string, unknown>): void;
  logProviderCall(entry: {
    provider: string;
    operation: string;
    success: boolean;
    context?: Record<string, unknown>;
  }): void;
  child(overrides: Partial<LoggerDefaults>): Logger;
}

export interface WorkerObservabilityContext {
  logger: Logger;
  requestId: string;
  correlationId: string;
}

function pickRequestId(request: Request): string {
  return request.headers.get('x-request-id')?.trim() || crypto.randomUUID();
}

function pickCorrelationId(request: Request, requestId: string): string {
  return request.headers.get('x-correlation-id')?.trim() || requestId;
}

function consoleMethod(level: LogLevel): (...args: unknown[]) => void {
  if (level === 'error') return console.error;
  if (level === 'warn') return console.warn;
  return console.log;
}

function emit(level: LogLevel, defaults: {
  source: LogSource;
  requestId: string;
  correlationId: string;
  route?: string | null;
  context?: Record<string, JsonValue>;
}, entry: LogEntry): void {
  const payload = {
    level,
    source: entry.source ?? defaults.source,
    event_type: entry.eventType,
    message: entry.message ?? null,
    request_id: defaults.requestId,
    correlation_id: defaults.correlationId,
    route: defaults.route ?? null,
    context: sanitizeContext({
      ...(defaults.context ?? {}),
      ...(entry.context ?? {}),
      ...(entry.error ? { error_message: errorMessage(entry.error) } : {}),
    }),
  };
  consoleMethod(level)('[api-booking]', JSON.stringify(payload));
}

function createLogger(defaults: LoggerDefaults): Logger {
  return {
    logInfo(entry) {
      emit('info', defaults, entry);
    },
    logWarn(entry) {
      emit('warn', defaults, entry);
    },
    logError(entry) {
      emit('error', defaults, entry);
    },
    captureException(entry) {
      emit('error', defaults, {
        ...entry,
        context: sanitizeContext({
          ...(entry.context ?? {}),
          error_details: errorToDetails(entry.error),
        }),
      });
    },
    info(message, context) {
      emit('info', defaults, { eventType: 'message', message, context: sanitizeContext(context ?? {}) });
    },
    warn(message, context) {
      emit('warn', defaults, { eventType: 'message', message, context: sanitizeContext(context ?? {}) });
    },
    error(message, context) {
      emit('error', defaults, { eventType: 'message', message, context: sanitizeContext(context ?? {}) });
    },
    logRequest(entry) {
      emit(entry.success ? 'info' : 'warn', defaults, {
        eventType: 'request',
        message: `${entry.method} ${entry.path}`,
        context: sanitizeContext({
          method: entry.method,
          url: entry.url,
          path: entry.path,
          status_code: entry.statusCode,
          duration_ms: entry.durationMs,
          success: entry.success,
          request_size_bytes: entry.requestSizeBytes ?? null,
          response_size_bytes: entry.responseSizeBytes ?? null,
        }),
      });
    },
    logMilestone(eventType, context) {
      emit('info', defaults, {
        eventType: 'flow_milestone',
        message: eventType,
        context: sanitizeContext({ milestone: eventType, ...(context ?? {}) }),
      });
    },
    logProviderCall(entry) {
      emit(entry.success ? 'info' : 'warn', defaults, {
        source: 'provider',
        eventType: 'provider_call',
        message: `${entry.provider}.${entry.operation}`,
        context: sanitizeContext({
          provider: entry.provider,
          operation: entry.operation,
          success: entry.success,
          ...(entry.context ?? {}),
        }),
      });
    },
    child(overrides) {
      return createLogger({
        source: overrides.source ?? defaults.source,
        requestId: overrides.requestId ?? defaults.requestId,
        correlationId: overrides.correlationId ?? defaults.correlationId,
        route: overrides.route ?? defaults.route,
        context: sanitizeContext({
          ...(defaults.context ?? {}),
          ...(overrides.context ?? {}),
        }),
      });
    },
  };
}

export function createWorkerObservability(
  _env: Env,
  request: Request,
  _executionCtx?: ExecutionContext | null,
  source: LogSource = 'worker',
): WorkerObservabilityContext {
  const requestId = pickRequestId(request);
  const correlationId = pickCorrelationId(request, requestId);
  const url = new URL(request.url);
  return {
    logger: createLogger({
      source,
      requestId,
      correlationId,
      route: url.pathname,
      context: {
        runtime: 'cloudflare-worker',
        method: request.method,
      },
    }),
    requestId,
    correlationId,
  };
}

export function createCronObservability(
  _env: Env,
  cron: string,
  _executionCtx?: ExecutionContext | null,
): WorkerObservabilityContext {
  const requestId = crypto.randomUUID();
  return {
    logger: createLogger({
      source: 'cron',
      requestId,
      correlationId: requestId,
      route: `/cron/${cron}`,
      context: {
        runtime: 'cloudflare-worker',
        cron,
      },
    }),
    requestId,
    correlationId: requestId,
  };
}
