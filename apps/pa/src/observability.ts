import { FRONTEND_OBSERVABILITY_ENDPOINT, makeRuntimeId, readStorageId } from "./runtime";

const OBS_ENDPOINT = FRONTEND_OBSERVABILITY_ENDPOINT;
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
let currentFlowId = makeRuntimeId("cid");

function baseEvent(payload: Record<string, unknown>) {
  const requestId =
    makeRuntimeId("rid");
  return {
    level: "info",
    eventType: "frontend_event",
    message: null,
    requestId,
    correlationId: currentFlowId,
    sessionId: readStorageId(typeof window === "undefined" ? null : window.localStorage, "pa_observability_session_id", "sid"),
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
  return readStorageId(typeof window === "undefined" ? null : window.localStorage, "pa_observability_session_id", "sid");
}

export function startFrontendFlow(name = "flow_started"): string {
  currentFlowId = makeRuntimeId("cid");
  void send({
    level: "info",
    correlationId: currentFlowId,
    eventType: "flow_milestone",
    message: name,
    context: { milestone: name },
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
      ...(context ?? {}),
    },
  });
}
