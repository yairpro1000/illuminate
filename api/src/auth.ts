import type { Context } from "hono";
import type { Db } from "./repo/supabase";

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

const userIdCache = new Map<string, { userId: string; expiresAt: number }>();
const USER_ID_CACHE_TTL_MS = 5 * 60 * 1000;

async function findAuthUserIdByEmail(db: Db, email: string): Promise<string | null> {
  const target = email.trim().toLowerCase();
  let page = 1;
  const perPage = 200;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = (data as any)?.users as Array<{ id: string; email?: string | null }> | undefined;
    for (const u of users ?? []) {
      if (typeof u?.email === "string" && u.email.trim().toLowerCase() === target) return u.id;
    }
    const nextPage = (data as any)?.nextPage as number | null | undefined;
    if (!nextPage) return null;
    page = nextPage;
  }
  return null;
}

async function getOrCreateAuthUserId(db: Db, email: string): Promise<string> {
  const cached = userIdCache.get(email);
  if (cached && cached.expiresAt > Date.now()) return cached.userId;

  const existing = await findAuthUserIdByEmail(db, email);
  if (existing) {
    userIdCache.set(email, { userId: existing, expiresAt: Date.now() + USER_ID_CACHE_TTL_MS });
    return existing;
  }

  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (error) {
    // Possible race: created between list+create. Retry once.
    const retry = await findAuthUserIdByEmail(db, email);
    if (retry) {
      userIdCache.set(email, { userId: retry, expiresAt: Date.now() + USER_ID_CACHE_TTL_MS });
      return retry;
    }
    throw error;
  }

  const createdId = (data as any)?.user?.id as string | undefined;
  if (!createdId) throw new Error("Failed to resolve Supabase auth user id.");
  userIdCache.set(email, { userId: createdId, expiresAt: Date.now() + USER_ID_CACHE_TTL_MS });
  return createdId;
}

export async function requireAccessUser(c: Context, db: Db): Promise<{ email: string; userId: string }> {
  const { email } = requireAccess(c);
  const userId = await getOrCreateAuthUserId(db, email);
  return { email, userId };
}
