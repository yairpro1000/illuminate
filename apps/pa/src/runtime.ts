const rawBase = (import.meta as any).env?.VITE_API_BASE ?? "/api";

export const API_BASE = String(rawBase).trim().replace(/\/+$/g, "");
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
