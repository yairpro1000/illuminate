import type { Context } from "hono";
import type { Env } from "./env";
import {
  createObservabilityLogger,
  errorMessage,
  normalizeFrontendLogInput,
  safePathname,
  SupabaseObservabilitySink,
  type JsonValue,
  type LogSource,
  type ObservabilityLogger,
  type PersistedLogEvent,
} from "../../shared/observability/backend.js";

const OBSERVABILITY_CTX_KEY = "__observability_logger";

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
  api?: PersistedLogEvent["api"];
  apiFailure?: PersistedLogEvent["apiFailure"];
  error?: PersistedLogEvent["error"];
}

function makeSink(env: Env): SupabaseObservabilitySink {
  return new SupabaseObservabilitySink({
    supabaseUrl: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SECRET_KEY,
    consoleTag: "[api-observability]",
  });
}

export function makeRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getExecutionCtx(c: Context): ExecutionContext | null {
  return ((c as any).executionCtx ?? null) as ExecutionContext | null;
}

export function attachObservability(c: Context, source: LogSource = "backend"): ApiObservabilityContext {
  const requestId = c.req.header("x-request-id")?.trim() || makeRequestId();
  const correlationId = c.req.header("x-correlation-id")?.trim() || requestId;

  c.header("X-Request-Id", requestId);
  c.header("X-Correlation-Id", correlationId);
  c.header("X-Worker", "yairb-pa-api");

  const logger = createObservabilityLogger({
    sink: makeSink(c.env as Env),
    schedule: getExecutionCtx(c) ? (promise) => getExecutionCtx(c)?.waitUntil(promise) : undefined,
    consoleTag: "[api]",
    defaults: {
      source,
      requestId,
      correlationId,
      route: c.req.path,
      context: {
        runtime: "cloudflare-worker",
        method: c.req.method,
      },
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
  return createObservabilityLogger({
    defaults: {
      source: "backend",
      requestId: (c as any).requestId ?? null,
      correlationId: (c as any).correlationId ?? (c as any).requestId ?? null,
      route: c.req.path,
    },
    consoleTag: "[api-fallback]",
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

  const event: PersistedLogEvent = {
    base: {
      source: "frontend",
      level: normalized.level,
      eventType: normalized.eventType,
      message: normalized.message,
      errorCode: normalized.errorCode,
      requestId,
      correlationId,
      userId: normalized.userId ?? null,
      sessionId: normalized.sessionId ?? null,
      route: normalized.route?.trim() || safePathname(c.req.url),
      context: {
        runtime: "browser",
        forwarded_via: "api",
        userAgent: c.req.header("user-agent") ?? null,
        ...(normalized.context ?? {}),
      },
    },
    api: normalized.api,
    apiFailure: normalized.apiFailure,
    error: normalized.error,
  };

  const exec = getExecutionCtx(c);
  const sink = makeSink(c.env as Env);
  if (exec) {
    exec.waitUntil(sink.capture(event));
    return;
  }
  await sink.capture(event);
}
