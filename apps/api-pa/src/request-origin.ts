import type { Context } from "hono";
import type { Env } from "./env";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

export function parseConfiguredOrigins(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(trimTrailingSlash),
  );
}

export function parseOrigin(raw: string | null): { origin: string | null; host: string | null } {
  if (!raw) return { origin: null, host: null };
  try {
    const parsed = new URL(raw);
    return {
      origin: trimTrailingSlash(parsed.origin),
      host: parsed.hostname.toLowerCase(),
    };
  } catch {
    return { origin: null, host: null };
  }
}

export function getRequestOrigin(c: Context): string | null {
  const value = c.req.header("origin");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getRequestHost(c: Context): string {
  try {
    return new URL(c.req.url).hostname.toLowerCase();
  } catch {
    return "unknown_host";
  }
}

export function isPagesDevHost(host: string | null): boolean {
  return Boolean(host && host.endsWith(".pages.dev"));
}

export function isWorkersDevHost(host: string | null): boolean {
  return Boolean(host && host.endsWith(".workers.dev"));
}

export function isAllowedCorsOrigin(env: Env, origin: string | null): origin is string {
  const parsed = parseOrigin(origin);
  if (!parsed.origin || !parsed.host) return false;

  if (parsed.host === "letsilluminate.co" || parsed.host.endsWith(".letsilluminate.co")) return true;
  if (parsed.host === "localhost" || parsed.host === "127.0.0.1") return true;

  const configured = parseConfiguredOrigins(env.API_ALLOWED_ORIGINS);
  return configured.has(parsed.origin);
}

export function isAllowedPreviewOrigin(env: Env, origin: string | null): boolean {
  const parsed = parseOrigin(origin);
  return isPagesDevHost(parsed.host) && isAllowedCorsOrigin(env, origin);
}
