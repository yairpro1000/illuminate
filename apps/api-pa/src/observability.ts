import type { Context } from "hono";
import {
  errorMessage,
  normalizeFrontendLogInput,
  safePathname,
  sanitizeContext,
  type JsonValue,
  type LogSource,
  type ObservabilityLogger,
} from "../../shared/observability/backend.js";

const OBSERVABILITY_CTX_KEY = "__observability_logger";

interface LoggerDefaults {
  source: LogSource;
  requestId?: string | null;
  correlationId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  route?: string | null;
  context?: Record<string, JsonValue>;
}

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface ApiObservabilityContext {
  logger: ObservabilityLogger;
  requestId: string;
  correlationId: string;
}

export interface FrontendLogPayload {
  level?: string;
  eventType?: string;
  message?: string | null;
  errorCode?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  sessionId?: string | null;
  route?: string | null;
  context?: Record<string, JsonValue>;
  api?: unknown;
  apiFailure?: unknown;
  error?: unknown;
}

function consoleMethod(level: LogLevel): (...args: unknown[]) => void {
  if (level === "error" || level === "fatal") return console.error;
  if (level === "warn") return console.warn;
  return console.log;
}

function emit(
  level: LogLevel,
  defaults: LoggerDefaults,
  eventType: string,
  message: string | null,
  context?: Record<string, JsonValue>,
): void {
  const payload = {
    ts: new Date().toISOString(),
    source: defaults.source,
    level,
    eventType,
    message,
    requestId: defaults.requestId ?? null,
    correlationId: defaults.correlationId ?? null,
    route: defaults.route ?? null,
    context: sanitizeContext({
      ...(defaults.context ?? {}),
      ...(context ?? {}),
    }),
  };
  consoleMethod(level)("[api-pa]", JSON.stringify(payload));
}

function createLogger(defaults: LoggerDefaults): ObservabilityLogger {
  return {
    info(message, context) {
      emit("info", defaults, "message", message, context);
    },
    warn(message, context) {
      emit("warn", defaults, "message", message, context);
    },
    error(message, context) {
      emit("error", defaults, "handled_exception", message, context);
    },
    logInfo(event) {
      emit("info", {
        ...defaults,
        source: event.source ?? defaults.source,
        requestId: event.requestId ?? defaults.requestId,
        correlationId: event.correlationId ?? defaults.correlationId,
        userId: event.userId ?? defaults.userId,
        sessionId: event.sessionId ?? defaults.sessionId,
        route: event.route ?? defaults.route,
      }, event.eventType, event.message ?? null, event.context);
    },
    logWarn(event) {
      emit("warn", {
        ...defaults,
        source: event.source ?? defaults.source,
        requestId: event.requestId ?? defaults.requestId,
        correlationId: event.correlationId ?? defaults.correlationId,
        userId: event.userId ?? defaults.userId,
        sessionId: event.sessionId ?? defaults.sessionId,
        route: event.route ?? defaults.route,
      }, event.eventType, event.message ?? null, event.context);
    },
    logError(event) {
      emit("error", {
        ...defaults,
        source: event.source ?? defaults.source,
        requestId: event.requestId ?? defaults.requestId,
        correlationId: event.correlationId ?? defaults.correlationId,
        userId: event.userId ?? defaults.userId,
        sessionId: event.sessionId ?? defaults.sessionId,
        route: event.route ?? defaults.route,
      }, event.eventType, event.message ?? null, event.context);
    },
    logMilestone(eventType, context, message) {
      emit("info", defaults, "flow_milestone", message ?? eventType, {
        milestone: eventType,
        ...(context ?? {}),
      });
    },
    logRequest(input) {
      emit(input.success ? "info" : "warn", defaults, input.success ? "request" : "request_failure", `${input.method} ${input.path}`, {
        method: input.method,
        url: input.url,
        path: input.path,
        status_code: input.statusCode,
        duration_ms: input.durationMs,
        success: input.success,
        request_size_bytes: input.requestSizeBytes ?? null,
        response_size_bytes: input.responseSizeBytes ?? null,
        ...(input.context ?? {}),
      });
    },
    logProviderCall(input) {
      emit(input.success ? "info" : "warn", {
        ...defaults,
        source: "provider",
      }, "provider_call", `${input.provider}.${input.operation}`, {
        provider: input.provider,
        operation: input.operation,
        method: input.method ?? null,
        path: input.path ?? null,
        status_code: input.statusCode ?? null,
        duration_ms: input.durationMs ?? null,
        success: input.success,
        retry_count: input.retryCount ?? null,
        ...(input.context ?? {}),
      });
    },
    captureException(input) {
      emit(input.level ?? "error", {
        ...defaults,
        source: input.source ?? defaults.source,
      }, input.eventType, input.message, {
        error_message: errorMessage(input.error),
        ...(input.context ?? {}),
      });
    },
    child(overrides) {
      return createLogger({
        ...defaults,
        ...overrides,
        context: sanitizeContext({
          ...(defaults.context ?? {}),
          ...(overrides.context ?? {}),
        }),
      });
    },
  };
}

export function makeRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function attachObservability(c: Context, source: LogSource = "backend"): ApiObservabilityContext {
  const existingLogger = (c as any)[OBSERVABILITY_CTX_KEY] as ObservabilityLogger | undefined;
  const existingRequestId = (c as any).requestId as string | undefined;
  const existingCorrelationId = (c as any).correlationId as string | undefined;
  if (existingLogger && existingRequestId && existingCorrelationId) {
    return { logger: existingLogger, requestId: existingRequestId, correlationId: existingCorrelationId };
  }

  const requestId = c.req.header("x-request-id")?.trim() || makeRequestId();
  const correlationId = c.req.header("x-correlation-id")?.trim() || requestId;

  c.header("X-Request-Id", requestId);
  c.header("X-Correlation-Id", correlationId);
  c.header("X-Worker", "yairb-pa-api");

  const logger = createLogger({
    source,
    requestId,
    correlationId,
    route: c.req.path,
    context: {
      app_area: "pa",
      runtime: "cloudflare-worker",
      method: c.req.method,
    },
  });

  (c as any).requestId = requestId;
  (c as any).correlationId = correlationId;
  (c as any)[OBSERVABILITY_CTX_KEY] = logger;
  return { logger, requestId, correlationId };
}

export function getLogger(c: Context): ObservabilityLogger {
  const logger = (c as any)[OBSERVABILITY_CTX_KEY] as ObservabilityLogger | undefined;
  if (logger) return logger;
  return createLogger({
    source: "backend",
    requestId: (c as any).requestId ?? null,
    correlationId: (c as any).correlationId ?? (c as any).requestId ?? null,
    route: c.req.path,
  });
}

export function getRequestId(c: Context): string | undefined {
  return (c as any).requestId as string | undefined;
}

export function getCorrelationId(c: Context): string | undefined {
  return (c as any).correlationId as string | undefined;
}

export function apiErrorMessage(error: unknown): string {
  return errorMessage(error);
}

export async function persistFrontendLog(c: Context, payload: FrontendLogPayload): Promise<void> {
  const normalized = normalizeFrontendLogInput(payload);
  if (!normalized) return;

  const requestId = normalized.requestId?.trim() || getRequestId(c) || makeRequestId();
  const correlationId = normalized.correlationId?.trim() || getCorrelationId(c) || requestId;

  const level = normalized.level === "warn" || normalized.level === "error" || normalized.level === "fatal"
    ? normalized.level
    : "info";

  const entry = {
    ts: new Date().toISOString(),
    source: "frontend",
    level,
    eventType: normalized.eventType,
    message: normalized.message ?? null,
    requestId,
    correlationId,
    route: normalized.route?.trim() || safePathname(c.req.url),
    context: sanitizeContext({
      app_area: "pa",
      runtime: "browser",
      forwarded_via: "api",
      userAgent: c.req.header("user-agent") ?? null,
      ...(normalized.context ?? {}),
    }),
  };

  consoleMethod(level)("[api-pa-frontend]", JSON.stringify(entry));
}
