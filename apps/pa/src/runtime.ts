const DEFAULT_PREVIEW_API_BASE = "https://pa-api.yairpro.workers.dev/api";

function sanitizeBase(value: string): string {
  return String(value).trim().replace(/\/+$/g, "");
}

export function resolvePaApiBase(input: {
  hostname?: string | null;
  envBase?: string | null;
  previewEnvBase?: string | null;
}): string {
  const envBase = sanitizeBase(input.envBase ?? "");
  if (envBase) return envBase;

  const hostname = String(input.hostname ?? "").trim().toLowerCase();
  if (hostname.endsWith(".pages.dev")) {
    const previewBase = sanitizeBase(input.previewEnvBase ?? "");
    return previewBase || DEFAULT_PREVIEW_API_BASE;
  }

  return "/api";
}

const rawBase = resolvePaApiBase({
  hostname: typeof window !== "undefined" ? window.location.hostname : "",
  envBase: (import.meta as any).env?.VITE_API_BASE ?? "",
  previewEnvBase: (import.meta as any).env?.VITE_PA_PREVIEW_API_BASE ?? "",
});

export const API_BASE = sanitizeBase(rawBase);
export const FRONTEND_OBSERVABILITY_ENDPOINT = `${API_BASE}/observability/frontend`;
export const PA_LOGOUT_URL =
  String((import.meta as any).env?.VITE_CLOUDFLARE_ACCESS_LOGOUT_URL ?? "").trim() ||
  "/cdn-cgi/access/logout";

export function makeRuntimeId(prefix: string): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as any).randomUUID()
    : `${prefix}_${Date.now().toString(16)}`;
}

export function readStorageId(storage: Storage | null, key: string, prefix: string): string {
  if (!storage) return `${prefix}_unavailable`;
  try {
    const existing = storage.getItem(key);
    if (existing) return existing;
    const created = makeRuntimeId(prefix);
    storage.setItem(key, created);
    return created;
  } catch {
    return `${prefix}_unavailable`;
  }
}
