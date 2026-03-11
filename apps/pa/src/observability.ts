const rawBase = (import.meta as any).env?.VITE_API_BASE ?? "/api";
const API_BASE = String(rawBase).trim().replace(/\/+$/g, "");
const OBS_ENDPOINT = `${API_BASE}/observability/frontend`;
const obsEnabledRaw = (import.meta as any).env?.VITE_FRONTEND_OBSERVABILITY_ENABLED;
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const isLocalHost = typeof window !== "undefined" && localHosts.has(window.location.hostname);

function parseBooleanFlag(value: unknown): boolean | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

const parsedObsEnabled = parseBooleanFlag(obsEnabledRaw);
let observabilityEnabled = parsedObsEnabled ?? isLocalHost;
let currentFlowId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as any).randomUUID()
    : `cid_${Date.now().toString(16)}`;

function sessionStorageId(key: string, prefix: string) {
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? (crypto as any).randomUUID()
        : `${prefix}_${Date.now().toString(16)}`;
    window.sessionStorage.setItem(key, created);
    return created;
  } catch {
    return `${prefix}_unavailable`;
  }
}

function localStorageId(key: string, prefix: string) {
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? (crypto as any).randomUUID()
        : `${prefix}_${Date.now().toString(16)}`;
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    return `${prefix}_unavailable`;
  }
}

function baseEvent(payload: Record<string, unknown>) {
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? (crypto as any).randomUUID()
      : `rid_${Date.now().toString(16)}`;
  return {
    level: "info",
    eventType: "frontend_event",
    message: null,
    requestId,
    correlationId: currentFlowId,
    sessionId: localStorageId("pa_observability_session_id", "sid"),
    route: window.location.pathname,
    context: {
      user_agent: navigator.userAgent,
      ...((payload.context as Record<string, unknown> | undefined) ?? {}),
    },
    ...payload,
  };
}

async function send(payload: Record<string, unknown>) {
  if (!observabilityEnabled) return;
  try {
    const event = baseEvent(payload);
    const res = await fetch(OBS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-id": String(event.requestId ?? ""),
        "x-correlation-id": String(event.correlationId ?? ""),
      },
      credentials: "include",
      keepalive: true,
      body: JSON.stringify(event),
    });
    // Endpoint unavailable on this deployment: stop retrying to avoid console noise.
    if (!res.ok && (res.status === 404 || res.status === 405)) observabilityEnabled = false;
  } catch {
    // Best-effort only.
  }
}

export function getFrontendCorrelationId(): string {
  return currentFlowId;
}

export function getFrontendSessionId(): string {
  return localStorageId("pa_observability_session_id", "sid");
}

export function startFrontendFlow(name = "flow_started"): string {
  currentFlowId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? (crypto as any).randomUUID()
      : `cid_${Date.now().toString(16)}`;
  void send({
    level: "info",
    correlationId: currentFlowId,
    eventType: "flow_milestone",
    message: name,
    context: { milestone: name, temporary_debug: true },
  });
  return currentFlowId;
}

export async function logFrontendInfo(payload: Record<string, unknown>) {
  await send({ level: "info", ...payload });
}

export async function logFrontendWarn(payload: Record<string, unknown>) {
  await send({ level: "warn", ...payload });
}

export async function logFrontendError(payload: Record<string, unknown>) {
  await send({ level: "error", ...payload });
}

export async function logFrontendMilestone(name: string, context?: Record<string, unknown>) {
  await send({
    level: "info",
    eventType: "flow_milestone",
    message: name,
    context: {
      milestone: name,
      temporary_debug: true,
      ...(context ?? {}),
    },
  });
}
