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

const PII_KEYS = new Set([
  "email",
  "phone",
  "message",
  "text",
  "body",
  "notes",
  "attendee",
  "attendees",
  "attendeeemail",
  "attendeename",
  "reply_to",
  "replyto",
  "recipient",
  "recipients",
  "to",
  "cc",
  "bcc",
  "first_name",
  "lastname",
  "last_name",
  "firstname",
  "full_name",
  "client_email",
  "client_phone",
  "client_name",
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

function isPiiKey(key: string): boolean {
  const normalized = normalizeKey(key).replace(/[^a-z0-9_]/g, "");
  return (
    PII_KEYS.has(normalized) ||
    normalized.includes("email") ||
    normalized.includes("phone") ||
    normalized.includes("attendee") ||
    normalized.includes("replyto") ||
    normalized.includes("recipient") ||
    normalized.includes("clientemail") ||
    normalized.includes("clientphone")
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
      if (isPiiKey(key)) {
        out[key] = "[redacted]";
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
