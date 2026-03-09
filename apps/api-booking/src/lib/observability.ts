import type { Env } from "../env.js";
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
} from "../../../shared/observability/backend.js";

export type Logger = ObservabilityLogger;

export interface WorkerObservabilityContext {
  logger: Logger;
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

function pickRequestId(request: Request): string {
  return request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
}

function pickCorrelationId(request: Request, requestId: string): string {
  return request.headers.get("x-correlation-id")?.trim() || requestId;
}

function scheduleWith(ctx?: ExecutionContext | null) {
  return ctx ? (promise: Promise<unknown>) => ctx.waitUntil(promise) : undefined;
}

function makeSink(env: Env): SupabaseObservabilitySink {
  return new SupabaseObservabilitySink({
    supabaseUrl: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    consoleTag: "[worker-observability]",
  });
}

export function createWorkerObservability(
  env: Env,
  request: Request,
  executionCtx?: ExecutionContext | null,
  source: LogSource = "worker",
): WorkerObservabilityContext {
  const requestId = pickRequestId(request);
  const correlationId = pickCorrelationId(request, requestId);
  const url = new URL(request.url);
  const logger = createObservabilityLogger({
    sink: makeSink(env),
    schedule: scheduleWith(executionCtx),
    consoleTag: "[worker]",
    defaults: {
      source,
      requestId,
      correlationId,
      route: url.pathname,
      context: {
        runtime: "cloudflare-worker",
        method: request.method,
      },
    },
  });

  return { logger, requestId, correlationId };
}

export function createCronObservability(
  env: Env,
  cron: string,
  executionCtx?: ExecutionContext | null,
): WorkerObservabilityContext {
  const requestId = crypto.randomUUID();
  const logger = createObservabilityLogger({
    sink: makeSink(env),
    schedule: scheduleWith(executionCtx),
    consoleTag: "[worker-cron]",
    defaults: {
      source: "cron",
      requestId,
      correlationId: requestId,
      route: `/cron/${cron}`,
      context: {
        runtime: "cloudflare-worker",
        cron,
      },
    },
  });
  return { logger, requestId, correlationId: requestId };
}

export async function persistFrontendLog(
  env: Env,
  payload: FrontendLogPayload,
  request: Request,
  executionCtx?: ExecutionContext | null,
): Promise<void> {
  const normalized = normalizeFrontendLogInput(payload);
  if (!normalized) return;
  const requestId = normalized.requestId?.trim() || pickRequestId(request);
  const correlationId = normalized.correlationId?.trim() || pickCorrelationId(request, requestId);
  const sink = makeSink(env);

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
      route: normalized.route?.trim() || safePathname(request.url),
      context: {
        runtime: "browser",
        forwarded_via: "worker",
        userAgent: request.headers.get("user-agent") ?? null,
        ...(normalized.context ?? {}),
      },
    },
    api: normalized.api,
    apiFailure: normalized.apiFailure,
    error: normalized.error,
  };

  if (executionCtx) {
    executionCtx.waitUntil(sink.capture(event));
    return;
  }
  await sink.capture(event);
}

export function handlerErrorMessage(error: unknown): string {
  return errorMessage(error);
}
