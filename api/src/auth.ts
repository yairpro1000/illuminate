import type { Context } from "hono";

function headerValue(c: Context, name: string): string | null {
  const v = c.req.header(name);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isLocalhostRequest(c: Context): boolean {
  try {
    const url = new URL(c.req.url);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

export function getAccessEmail(c: Context): string | null {
  const fromAccess =
    headerValue(c, "cf-access-authenticated-user-email") ??
    headerValue(c, "Cf-Access-Authenticated-User-Email");
  if (fromAccess) return fromAccess;

  // Local dev fallback: allow bypassing Access only on localhost and only when explicitly configured.
  const devEmail = (c as any)?.env?.PA_DEV_EMAIL;
  if (typeof devEmail === "string" && devEmail.trim() && isLocalhostRequest(c)) return devEmail.trim();

  return null;
}

export function requireAccess(c: Context): { email: string } {
  const email = getAccessEmail(c);
  if (!email) {
    const err = new Error("unauthorized");
    (err as any).status = 401;
    throw err;
  }
  return { email };
}
