export type LogSource = "frontend" | "backend" | "worker" | "cron" | "provider";
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface BaseLogRecord {
  source: LogSource;
  level: LogLevel;
  eventType: string;
  message?: string | null;
  errorCode?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  route?: string | null;
  context?: Record<string, JsonValue>;
}

export interface ApiLogRecord {
  direction: "inbound" | "outbound";
  provider?: string | null;
  method?: string | null;
  url?: string | null;
  path?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  success: boolean;
  retryCount?: number | null;
  requestSizeBytes?: number | null;
  responseSizeBytes?: number | null;
}

export interface ApiFailureDetailRecord {
  requestHeaders?: Record<string, JsonValue> | null;
  requestBody?: JsonValue;
  responseHeaders?: Record<string, JsonValue> | null;
  responseBody?: JsonValue;
  providerError?: string | null;
  stackTrace?: string | null;
  redactionNote?: string | null;
}

export interface ErrorDetailRecord {
  errorName?: string | null;
  stackTrace?: string | null;
  component?: string | null;
  runtime?: string | null;
  browser?: string | null;
  file?: string | null;
  functionName?: string | null;
  lineNumber?: number | null;
  columnNumber?: number | null;
  extra?: Record<string, JsonValue>;
}

export interface PersistedLogEvent {
  base: BaseLogRecord;
  api?: ApiLogRecord;
  apiFailure?: ApiFailureDetailRecord;
  error?: ErrorDetailRecord;
}

export interface FrontendLogInput {
  level?: unknown;
  eventType?: unknown;
  message?: unknown;
  errorCode?: unknown;
  requestId?: unknown;
  correlationId?: unknown;
  userId?: unknown;
  sessionId?: unknown;
  route?: unknown;
  context?: unknown;
  api?: unknown;
  apiFailure?: unknown;
  error?: unknown;
}

type Scheduler = (promise: Promise<unknown>) => void;

const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api_key",
  "token",
  "password",
  "secret",
  "access_token",
  "refresh_token",
  "client_secret",
  "assertion",
  "signature",
]);

const MAX_TEXT_PREVIEW = 4_000;
const MAX_JSON_DEPTH = 6;
const MAX_JSON_KEYS = 50;
const MAX_ARRAY_ITEMS = 50;

function truncateText(value: string, max = MAX_TEXT_PREVIEW): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

function clampString(value: unknown, max = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return truncateText(trimmed, max);
}

function normalizeKey(key: string): string {
  return String(key ?? "").trim().toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    REDACTED_KEYS.has(normalized) ||
    normalized.includes("auth") ||
    normalized.includes("cookie") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("key") ||
    normalized.includes("signature") ||
    normalized.includes("assertion")
  );
}

function isBinaryLike(value: unknown): boolean {
  if (value instanceof ArrayBuffer) return true;
  if (typeof Uint8Array !== "undefined" && value instanceof Uint8Array) return true;
  return false;
}

function maskSecret(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (!raw) return "[redacted]";
  if (raw.length <= 8) return "[redacted]";
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}

function sanitizeUrlString(value: string): string {
  try {
    const url = new URL(value);
    const redacted = new URL(url.origin + url.pathname);
    url.searchParams.forEach((paramValue, key) => {
      if (isSensitiveKey(key)) {
        redacted.searchParams.set(key, "[redacted]");
        return;
      }
      redacted.searchParams.set(key, truncateText(paramValue, 120));
    });
    return redacted.toString();
  } catch {
    return truncateText(value);
  }
}

function sanitizeUrlEncodedString(value: string): string {
  const params = new URLSearchParams(value);
  const out = new URLSearchParams();
  params.forEach((paramValue, key) => {
    out.set(key, isSensitiveKey(key) ? "[redacted]" : truncateText(paramValue, 120));
  });
  return truncateText(out.toString());
}

function looksLikeUrlEncoded(value: string): boolean {
  return value.includes("=") && (value.includes("&") || value.startsWith("grant_type=") || value.startsWith("secret="));
}

function sanitizeUnknown(value: unknown, depth = 0): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return sanitizeUrlString(value);
    if (looksLikeUrlEncoded(value)) return sanitizeUrlEncodedString(value);
    return truncateText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (isBinaryLike(value)) return "[binary omitted]";

  if (depth >= MAX_JSON_DEPTH) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeUnknown(item, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateText(value.message),
      stack: value.stack ? truncateText(value.stack) : null,
    };
  }

  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_JSON_KEYS);
    for (const [rawKey, rawValue] of entries) {
      const key = String(rawKey);
      if (isSensitiveKey(key)) {
        out[key] = maskSecret(rawValue);
        continue;
      }
      out[key] = sanitizeUnknown(rawValue, depth + 1);
    }
    return out;
  }

  return truncateText(String(value));
}

export function sanitizeContext(value: unknown): Record<string, JsonValue> {
  const sanitized = sanitizeUnknown(value);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as Record<string, JsonValue>;
  }
  return { value: sanitized };
}

export function sanitizeHeaders(headers?: HeadersInit | null): Record<string, JsonValue> | null {
  if (!headers) return null;
  const out: Record<string, JsonValue> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      const normalized = normalizeKey(key);
      if (isSensitiveKey(key)) {
        out[key] = maskSecret(value);
        return;
      }
      out[key] = sanitizeUnknown(value);
    });
    return out;
  }

  const pairs = Array.isArray(headers)
    ? headers
    : Object.entries(headers as Record<string, string>);

  for (const [key, value] of pairs) {
    if (isSensitiveKey(key)) {
      out[key] = maskSecret(value);
      continue;
    }
    out[key] = sanitizeUnknown(value);
  }
  return out;
}

export function sanitizeBody(body: unknown): JsonValue {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return "";
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return sanitizeUnknown(JSON.parse(trimmed));
      } catch {
        return truncateText(trimmed);
      }
    }
    if (looksLikeUrlEncoded(trimmed)) {
      return sanitizeUrlEncodedString(trimmed);
    }
    return truncateText(trimmed);
  }
  return sanitizeUnknown(body);
}

export function estimateBytes(body: unknown): number | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (isBinaryLike(body)) {
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (body instanceof Uint8Array) return body.byteLength;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(body)).byteLength;
  } catch {
    return null;
  }
}

export function errorToDetails(error: unknown): ErrorDetailRecord {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      stackTrace: error.stack ? truncateText(error.stack, 12_000) : null,
      extra: { message: truncateText(error.message) },
    };
  }
  return {
    errorName: "UnknownError",
    extra: { message: truncateText(String(error)) },
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return truncateText(error.message);
  return truncateText(String(error));
}

export function sanitizeBrowserPath(pathname: string, search?: string): string {
  if (!search) return pathname;
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  params.forEach((value, key) => {
    if (isSensitiveKey(key)) return;
    kept.set(key, truncateText(value, 120));
  });
  const suffix = kept.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

function sanitizeClientRoute(route: string): string {
  try {
    if (/^https?:\/\//i.test(route)) {
      const url = new URL(route);
      return sanitizeBrowserPath(url.pathname, url.search);
    }
    const url = new URL(route, "https://observability.local");
    return sanitizeBrowserPath(url.pathname, url.search);
  } catch {
    const [pathname, rawSearch] = route.split("?", 2);
    return sanitizeBrowserPath(pathname || "/", rawSearch ? `?${rawSearch}` : "");
  }
}

export function headerByteLength(headers?: Headers | null): number | null {
  const value = headers?.get("content-length");
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeFrontendLogInput(payload: unknown): {
  level: LogLevel;
  eventType: string;
  message: string | null;
  errorCode: string | null;
  requestId: string | null;
  correlationId: string | null;
  userId: string | null;
  sessionId: string | null;
  route: string | null;
  context: Record<string, JsonValue>;
  api?: ApiLogRecord;
  apiFailure?: ApiFailureDetailRecord;
  error?: ErrorDetailRecord;
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const input = payload as FrontendLogInput;
  const level = input.level === "debug" || input.level === "info" || input.level === "warn" || input.level === "error" || input.level === "fatal"
    ? input.level
    : "error";
  const eventType = clampString(input.eventType, 120) ?? "frontend_event";
  const rawRoute = clampString(input.route, 256);
  const route = rawRoute ? sanitizeClientRoute(rawRoute) : null;
  const context = sanitizeContext(input.context ?? {});
  const normalized: {
    level: LogLevel;
    eventType: string;
    message: string | null;
    errorCode: string | null;
    requestId: string | null;
    correlationId: string | null;
    userId: string | null;
    sessionId: string | null;
    route: string | null;
    context: Record<string, JsonValue>;
    api?: ApiLogRecord;
    apiFailure?: ApiFailureDetailRecord;
    error?: ErrorDetailRecord;
  } = {
    level,
    eventType,
    message: clampString(input.message, 1000),
    errorCode: clampString(input.errorCode, 120),
    requestId: clampString(input.requestId, 120),
    correlationId: clampString(input.correlationId, 120),
    userId: clampString(input.userId, 120),
    sessionId: clampString(input.sessionId, 120),
    route,
    context,
  };

  if (input.api && typeof input.api === "object" && !Array.isArray(input.api)) {
    const api = input.api as Record<string, unknown>;
    normalized.api = {
      direction: api.direction === "inbound" ? "inbound" : "outbound",
      provider: clampString(api.provider, 120),
      method: clampString(api.method, 16),
      url: clampString(api.url, 1000),
      path: clampString(api.path, 512),
      statusCode: typeof api.statusCode === "number" ? api.statusCode : null,
      durationMs: typeof api.durationMs === "number" ? api.durationMs : null,
      success: api.success === true,
      retryCount: typeof api.retryCount === "number" ? api.retryCount : 0,
      requestSizeBytes: typeof api.requestSizeBytes === "number" ? api.requestSizeBytes : null,
      responseSizeBytes: typeof api.responseSizeBytes === "number" ? api.responseSizeBytes : null,
    };
  }

  if (input.apiFailure && typeof input.apiFailure === "object" && !Array.isArray(input.apiFailure)) {
    const apiFailure = input.apiFailure as Record<string, unknown>;
    normalized.apiFailure = {
      requestHeaders: sanitizeContext(apiFailure.requestHeaders ?? {}),
      requestBody: sanitizeBody(apiFailure.requestBody),
      responseHeaders: sanitizeContext(apiFailure.responseHeaders ?? {}),
      responseBody: sanitizeBody(apiFailure.responseBody),
      providerError: clampString(apiFailure.providerError, 1000),
      stackTrace: clampString(apiFailure.stackTrace, 12_000),
      redactionNote: clampString(apiFailure.redactionNote, 240),
    };
  }

  if (input.error && typeof input.error === "object" && !Array.isArray(input.error)) {
    const error = input.error as Record<string, unknown>;
    normalized.error = {
      errorName: clampString(error.errorName, 240),
      stackTrace: clampString(error.stackTrace, 12_000),
      component: clampString(error.component, 240),
      runtime: clampString(error.runtime, 120),
      browser: clampString(error.browser, 240),
      file: clampString(error.file, 512),
      functionName: clampString(error.functionName, 240),
      lineNumber: typeof error.lineNumber === "number" ? error.lineNumber : null,
      columnNumber: typeof error.columnNumber === "number" ? error.columnNumber : null,
      extra: sanitizeContext(error.extra ?? {}),
    };
  }

  return normalized;
}

export interface SupabaseObservabilitySinkOptions {
  supabaseUrl?: string | null;
  serviceRoleKey?: string | null;
  schema?: string;
  fetchFn?: typeof fetch;
  consoleTag?: string;
}

export class SupabaseObservabilitySink {
  private readonly supabaseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly schema: string;
  private readonly fetchFn: typeof fetch;
  private readonly consoleTag: string;

  constructor(opts: SupabaseObservabilitySinkOptions) {
    this.supabaseUrl = String(opts.supabaseUrl ?? "").replace(/\/+$/g, "");
    this.serviceRoleKey = String(opts.serviceRoleKey ?? "");
    this.schema = opts.schema ?? "observability";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.consoleTag = opts.consoleTag ?? "[observability]";
  }

  isConfigured(): boolean {
    return Boolean(this.supabaseUrl && this.serviceRoleKey);
  }

  async capture(event: PersistedLogEvent): Promise<void> {
    if (!this.isConfigured()) return;

    const inserted = await this.insert("logs", {
      source: event.base.source,
      level: event.base.level,
      event_type: event.base.eventType,
      message: event.base.message ?? null,
      error_code: event.base.errorCode ?? null,
      request_id: event.base.requestId ?? null,
      correlation_id: event.base.correlationId ?? null,
      user_id: event.base.userId ?? null,
      session_id: event.base.sessionId ?? null,
      route: event.base.route ?? null,
      context: sanitizeContext(event.base.context ?? {}),
    });

    const logId = typeof inserted?.id === "string" ? inserted.id : null;
    if (!logId) return;

    let apiLogId: string | null = null;
    if (event.api) {
      const apiInserted = await this.insert("api_logs", {
        log_id: logId,
        direction: event.api.direction,
        provider: event.api.provider ?? null,
        method: event.api.method ?? null,
        url: typeof event.api.url === "string" ? sanitizeUrlString(event.api.url) : null,
        path: event.api.path ?? null,
        status_code: event.api.statusCode ?? null,
        duration_ms: event.api.durationMs ?? null,
        success: event.api.success,
        retry_count: event.api.retryCount ?? 0,
        request_size_bytes: event.api.requestSizeBytes ?? null,
        response_size_bytes: event.api.responseSizeBytes ?? null,
      });
      apiLogId = typeof apiInserted?.id === "string" ? apiInserted.id : null;
    }

    if (apiLogId && event.apiFailure) {
      await this.insert("api_failure_details", {
        api_log_id: apiLogId,
        request_headers: sanitizeContext(event.apiFailure.requestHeaders ?? {}),
        request_body: sanitizeBody(event.apiFailure.requestBody),
        response_headers: sanitizeContext(event.apiFailure.responseHeaders ?? {}),
        response_body: sanitizeBody(event.apiFailure.responseBody),
        provider_error: event.apiFailure.providerError ?? null,
        stack_trace: event.apiFailure.stackTrace ? truncateText(event.apiFailure.stackTrace, 12_000) : null,
        redaction_note: event.apiFailure.redactionNote ?? null,
      });
    }

    if (event.error) {
      await this.insert("error_details", {
        log_id: logId,
        error_name: event.error.errorName ?? null,
        stack_trace: event.error.stackTrace ? truncateText(event.error.stackTrace, 12_000) : null,
        component: event.error.component ?? null,
        runtime: event.error.runtime ?? null,
        browser: event.error.browser ?? null,
        file: event.error.file ?? null,
        function_name: event.error.functionName ?? null,
        line_number: event.error.lineNumber ?? null,
        column_number: event.error.columnNumber ?? null,
        extra: sanitizeContext(event.error.extra ?? {}),
      });
    }
  }

  private async insert(table: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.fetchFn(`${this.supabaseUrl}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          apikey: this.serviceRoleKey,
          Authorization: `Bearer ${this.serviceRoleKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Prefer: "return=representation",
          "Accept-Profile": this.schema,
          "Content-Profile": this.schema,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        console.warn(this.consoleTag, `failed to insert into ${table}`, truncateText(text));
        return null;
      }

      const data = (await res.json()) as Array<Record<string, unknown>>;
      return data[0] ?? null;
    } catch (error) {
      console.warn(this.consoleTag, `failed to insert into ${table}`, error);
      return null;
    }
  }
}

export interface LoggerDefaults {
  source: LogSource;
  requestId?: string | null;
  correlationId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  route?: string | null;
  context?: Record<string, JsonValue>;
}

export interface ProviderCallInput {
  provider: string;
  operation: string;
  method?: string | null;
  url?: string | null;
  path?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  success: boolean;
  retryCount?: number | null;
  requestHeaders?: HeadersInit | null;
  requestBody?: unknown;
  responseHeaders?: HeadersInit | null;
  responseBody?: unknown;
  requestSizeBytes?: number | null;
  responseSizeBytes?: number | null;
  error?: unknown;
  context?: Record<string, JsonValue>;
}

export interface RequestLogInput {
  method: string;
  url: string;
  path: string;
  statusCode: number;
  durationMs: number;
  success: boolean;
  requestSizeBytes?: number | null;
  responseSizeBytes?: number | null;
  context?: Record<string, JsonValue>;
}

export interface ExceptionLogInput {
  eventType: string;
  message: string;
  error: unknown;
  level?: LogLevel;
  errorCode?: string | null;
  context?: Record<string, JsonValue>;
  source?: LogSource;
}

export interface ObservabilityLogger {
  info(message: string, context?: Record<string, JsonValue>): void;
  warn(message: string, context?: Record<string, JsonValue>): void;
  error(message: string, context?: Record<string, JsonValue>): void;
  logInfo(event: Omit<BaseLogRecord, "level" | "source"> & { source?: LogSource }): void;
  logWarn(event: Omit<BaseLogRecord, "level" | "source"> & { source?: LogSource }): void;
  logError(event: Omit<BaseLogRecord, "level" | "source"> & { source?: LogSource }): void;
  logMilestone(eventType: string, context?: Record<string, JsonValue>, message?: string): void;
  logRequest(input: RequestLogInput): void;
  logProviderCall(input: ProviderCallInput): void;
  captureException(input: ExceptionLogInput): void;
  child(overrides: Partial<LoggerDefaults>): ObservabilityLogger;
}

export interface CreateLoggerOptions {
  sink?: SupabaseObservabilitySink | null;
  defaults: LoggerDefaults;
  schedule?: Scheduler;
  consoleTag?: string;
}

export function fireAndForget(promise: Promise<unknown>, schedule?: Scheduler): void {
  const safePromise = promise.catch((error) => {
    console.warn("[observability] async logging failed", error);
  });
  if (schedule) {
    schedule(safePromise);
    return;
  }
  void safePromise;
}

export function createObservabilityLogger(opts: CreateLoggerOptions): ObservabilityLogger {
  const sink = opts.sink ?? null;
  const defaults = opts.defaults;
  const consoleTag = opts.consoleTag ?? "[observability]";

  function mergeBase(
    level: LogLevel,
    record: Omit<BaseLogRecord, "level" | "source"> & { source?: LogSource },
  ): BaseLogRecord {
    return {
      source: record.source ?? defaults.source,
      level,
      eventType: record.eventType,
      message: record.message ?? null,
      errorCode: record.errorCode ?? null,
      requestId: record.requestId ?? defaults.requestId ?? null,
      correlationId: record.correlationId ?? defaults.correlationId ?? null,
      userId: record.userId ?? defaults.userId ?? null,
      sessionId: record.sessionId ?? defaults.sessionId ?? null,
      route: record.route ?? defaults.route ?? null,
      context: {
        ...(defaults.context ?? {}),
        ...(record.context ?? {}),
      },
    };
  }

  function emit(event: PersistedLogEvent): void {
    const consoleRecord = {
      ts: new Date().toISOString(),
      source: event.base.source,
      level: event.base.level,
      eventType: event.base.eventType,
      message: event.base.message ?? null,
      requestId: event.base.requestId ?? null,
      correlationId: event.base.correlationId ?? null,
      route: event.base.route ?? null,
      context: event.base.context ?? {},
      api: event.api
        ? {
            direction: event.api.direction,
            provider: event.api.provider ?? null,
            method: event.api.method ?? null,
            path: event.api.path ?? null,
            statusCode: event.api.statusCode ?? null,
            durationMs: event.api.durationMs ?? null,
            success: event.api.success,
          }
        : undefined,
    };

    const line = JSON.stringify(consoleRecord);
    if (event.base.level === "error" || event.base.level === "fatal") {
      console.error(`${consoleTag} ${line}`);
    } else if (event.base.level === "warn") {
      console.warn(`${consoleTag} ${line}`);
    } else {
      console.log(`${consoleTag} ${line}`);
    }

    if (sink?.isConfigured()) {
      fireAndForget(sink.capture(event), opts.schedule);
    }
  }

  function makeChild(overrides: Partial<LoggerDefaults>): ObservabilityLogger {
    return createObservabilityLogger({
      ...opts,
      defaults: {
        ...defaults,
        ...overrides,
        context: {
          ...(defaults.context ?? {}),
          ...(overrides.context ?? {}),
        },
      },
    });
  }

  return {
    info(message, context) {
      emit({
        base: mergeBase("info", {
          eventType: "message",
          message,
          context,
        }),
      });
    },
    warn(message, context) {
      emit({
        base: mergeBase("warn", {
          eventType: "message",
          message,
          context,
        }),
      });
    },
    error(message, context) {
      emit({
        base: mergeBase("error", {
          eventType: "handled_exception",
          message,
          context,
        }),
      });
    },
    logInfo(event) {
      emit({ base: mergeBase("info", event) });
    },
    logWarn(event) {
      emit({ base: mergeBase("warn", event) });
    },
    logError(event) {
      emit({ base: mergeBase("error", event) });
    },
    logMilestone(eventType, context, message) {
      emit({
        base: mergeBase("info", {
          eventType: "flow_milestone",
          message: message ?? eventType,
          context: {
            milestone: eventType,
            temporary_debug: true,
            ...(context ?? {}),
          },
        }),
      });
    },
    logRequest(input) {
      const safeUrl = /^https?:\/\//i.test(input.url) ? sanitizeUrlString(input.url) : truncateText(input.url, 1000);
      emit({
        base: mergeBase(input.success ? "info" : "error", {
          eventType: input.success ? "request" : "request_failure",
          message: `${input.method} ${input.path}`,
          context: {
            method: input.method,
            url: safeUrl,
            ...(input.context ?? {}),
          },
        }),
        api: {
          direction: "inbound",
          method: input.method,
          url: safeUrl,
          path: input.path,
          statusCode: input.statusCode,
          durationMs: input.durationMs,
          success: input.success,
          requestSizeBytes: input.requestSizeBytes ?? null,
          responseSizeBytes: input.responseSizeBytes ?? null,
        },
      });
    },
    logProviderCall(input) {
      const err = input.error;
      emit({
        base: mergeBase(input.success ? "info" : "error", {
          source: "provider",
          eventType: input.success ? "provider_call" : "provider_failure",
          message: `${input.provider}.${input.operation}`,
          context: {
            operation: input.operation,
            caller_source: defaults.source,
            ...(input.context ?? {}),
          },
        }),
        api: {
          direction: "outbound",
          provider: input.provider,
          method: input.method ?? null,
          url: input.url ?? null,
          path: input.path ?? null,
          statusCode: input.statusCode ?? null,
          durationMs: input.durationMs ?? null,
          success: input.success,
          retryCount: input.retryCount ?? 0,
          requestSizeBytes: input.requestSizeBytes ?? null,
          responseSizeBytes: input.responseSizeBytes ?? null,
        },
        apiFailure: input.success
          ? undefined
          : {
              requestHeaders: sanitizeHeaders(input.requestHeaders),
              requestBody: sanitizeBody(input.requestBody),
              responseHeaders: sanitizeHeaders(input.responseHeaders),
              responseBody: sanitizeBody(input.responseBody),
              providerError: err ? errorMessage(err) : null,
              stackTrace: err instanceof Error ? err.stack ?? null : null,
              redactionNote: "Sensitive headers and bodies were redacted/truncated before storage.",
            },
      });
    },
    captureException(input) {
      emit({
        base: mergeBase(input.level ?? "error", {
          source: input.source,
          eventType: input.eventType,
          message: input.message,
          errorCode: input.errorCode ?? null,
          context: input.context,
        }),
        error: errorToDetails(input.error),
      });
    },
    child: makeChild,
  };
}

export async function instrumentFetch(
  logger: ObservabilityLogger,
  input: {
    provider: string;
    operation: string;
    method?: string;
    url: string;
    headers?: HeadersInit | null;
    body?: unknown;
    retryCount?: number;
    fetchFn?: typeof fetch;
    init?: RequestInit;
  },
): Promise<Response> {
  const startedAt = Date.now();
  const fetchFn = input.fetchFn ?? fetch;
  const method = input.method ?? input.init?.method ?? "GET";

  try {
    const response = await fetchFn(input.url, {
      ...input.init,
      method,
      headers: input.headers ?? input.init?.headers,
      body: input.body !== undefined ? (typeof input.body === "string" ? input.body : JSON.stringify(input.body)) : input.init?.body,
    });

    const durationMs = Date.now() - startedAt;
    const responsePreview = response.ok ? null : await response.clone().text();

    logger.logProviderCall({
      provider: input.provider,
      operation: input.operation,
      method,
      url: input.url,
      path: safePathname(input.url),
      statusCode: response.status,
      durationMs,
      success: response.ok,
      retryCount: input.retryCount ?? 0,
      requestHeaders: input.headers ?? input.init?.headers ?? null,
      responseHeaders: response.headers,
      responseBody: responsePreview ? truncateText(responsePreview, 1_000) : null,
      requestSizeBytes: estimateBytes(input.body),
      responseSizeBytes: responsePreview ? estimateBytes(responsePreview) : null,
    });

    return response;
  } catch (error) {
    logger.logProviderCall({
      provider: input.provider,
      operation: input.operation,
      method,
      url: input.url,
      path: safePathname(input.url),
      durationMs: Date.now() - startedAt,
      success: false,
      retryCount: input.retryCount ?? 0,
      requestHeaders: input.headers ?? input.init?.headers ?? null,
      error,
      requestSizeBytes: estimateBytes(input.body),
    });
    throw error;
  }
}

export function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
