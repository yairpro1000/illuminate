import type { Context } from "hono";

function headerValue(c: Context, name: string): string | null {
  const v = c.req.header(name);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function getAccessEmail(c: Context): string | null {
  return (
    headerValue(c, "cf-access-authenticated-user-email") ??
    headerValue(c, "Cf-Access-Authenticated-User-Email")
  );
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

