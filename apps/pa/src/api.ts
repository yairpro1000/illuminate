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
  const res = await fetch(fullUrl, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-pa-device-id": getDeviceId(),
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.toLowerCase().includes("application/json");
  if (!isJson) {
    const text = await res.text();
    const details = text?.slice?.(0, 300) ?? "";
    const requestId = res.headers.get("x-request-id") ?? res.headers.get("X-Request-Id") ?? "";
    if (!res.ok) throw new Error(`${details || `HTTP ${res.status}`}${requestId ? ` (requestId: ${requestId})` : ""}`);
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
    const requestId = typeof (body as any)?.requestId === "string" ? (body as any).requestId : "";
    const details =
      typeof (body as any)?.details === "string" ? (body as any).details : JSON.stringify(body);
    throw new Error(
      `${details || `HTTP ${res.status}`}${requestId ? ` (requestId: ${requestId})` : ""}`,
    );
  }

  return body as T;
}
