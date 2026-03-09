import { getFrontendCorrelationId, logFrontendError, logFrontendInfo, startFrontendFlow } from "./observability";

const rawBase = (import.meta as any).env?.VITE_API_BASE ?? "/api";
export const API_BASE = String(rawBase).trim().replace(/\/+$/g, "");

function getDeviceId() {
  if (typeof window === "undefined") return "unknown_device";
  const key = "pa_device_id";
  let id = "";
  try {
    id = window.localStorage.getItem(key) ?? "";
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `dev_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
      window.localStorage.setItem(key, id);
    }
  } catch {
    id = "unknown_device";
  }
  return id;
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const fullUrl = url.startsWith("http")
    ? url
    : `${API_BASE}${url.startsWith("/") ? url : `/${url}`}`;
  const method = String(init?.method ?? "GET").toUpperCase();
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? (crypto as any).randomUUID()
      : `rid_${Date.now().toString(16)}`;
  const correlationId = method === "GET" ? getFrontendCorrelationId() : startFrontendFlow(`pa_${method.toLowerCase()}_${url.replace(/[^a-z0-9]+/gi, "_")}`);
  const startedAt = Date.now();
  const res = await fetch(fullUrl, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-pa-device-id": getDeviceId(),
      "x-request-id": requestId,
      "x-correlation-id": correlationId,
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.toLowerCase().includes("application/json");
  if (!isJson) {
    const text = await res.text();
    const details = text?.slice?.(0, 300) ?? "";
    const responseRequestId = res.headers.get("x-request-id") ?? res.headers.get("X-Request-Id") ?? "";
    if (!res.ok) {
      void logFrontendError({
        eventType: "request_failure",
        message: `${method} ${url}`,
        requestId: responseRequestId || requestId,
        correlationId,
        api: {
          direction: "outbound",
          provider: "pa_api",
          method: init?.method ?? "GET",
          url: fullUrl,
          path: url,
          statusCode: res.status,
          durationMs: Date.now() - startedAt,
          success: false,
        },
        apiFailure: {
          responseBody: details || "Internal error",
          redactionNote: "Frontend previews are truncated and secret headers are omitted.",
        },
      });
      throw new Error(
        `Non-JSON error from ${fullUrl} (${contentType || "unknown content-type"}, HTTP ${res.status}): ${
          details || "Internal error"
        }${responseRequestId ? ` (requestId: ${responseRequestId})` : ""}`.trim(),
      );
    }
    throw new Error(
      `Expected JSON from ${fullUrl} but got ${contentType || "unknown content-type"} (HTTP ${res.status}). ${
        details ? `Body starts with: ${JSON.stringify(details)}` : ""
      }`.trim(),
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e: any) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    throw new Error(`Failed to parse JSON from ${fullUrl} (HTTP ${res.status}): ${String(e?.message ?? e)}`);
  }

  if (!res.ok) {
    const responseRequestId = typeof (body as any)?.requestId === "string" ? (body as any).requestId : "";
    const details =
      typeof (body as any)?.details === "string" ? (body as any).details : JSON.stringify(body);
    void logFrontendError({
      eventType: "request_failure",
      message: `${method} ${url}`,
      requestId: responseRequestId || requestId,
      correlationId,
      api: {
        direction: "outbound",
        provider: "pa_api",
        method: init?.method ?? "GET",
        url: fullUrl,
        path: url,
        statusCode: res.status,
        durationMs: Date.now() - startedAt,
        success: false,
      },
      apiFailure: {
        responseBody: details,
        redactionNote: "Frontend previews are truncated and secret headers are omitted.",
      },
    });
    throw new Error(
      `${details || `HTTP ${res.status}`}${responseRequestId ? ` (requestId: ${responseRequestId})` : ""}`,
    );
  }

  void logFrontendInfo({
    eventType: "request",
    message: `${method} ${url}`,
    requestId,
    correlationId,
    api: {
      direction: "outbound",
      provider: "pa_api",
      method,
      url: fullUrl,
      path: url,
      statusCode: res.status,
      durationMs: Date.now() - startedAt,
      success: true,
    },
  });

  return body as T;
}
