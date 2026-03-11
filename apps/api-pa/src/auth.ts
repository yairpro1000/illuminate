import type { Context } from "hono";
import type { Db } from "./repo/supabase";
import { getLogger } from "./observability";

function normalizeEmailLike(raw: string): string {
  let s = String(raw ?? "").trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1).trim();
  const angle = s.match(/<([^>]+)>/);
  if (angle?.[1]) s = angle[1].trim();
  return s;
}

function isValidEmailFormat(email: string): boolean {
  // Intentionally simple: good enough for rejecting obvious local-dev mistakes.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function headerValue(c: Context, name: string): string | null {
  const v = c.req.header(name);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isLocalhostRequest(c: Context): boolean {
  try {
    const url = new URL(c.req.url);
    const host = url.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

type AccessDecision =
  | {
      allowed: true;
      email: string;
      branch: "cf_access_header" | "localhost_dev_email";
      host: string;
      devEmailConfigured: boolean;
    }
  | {
      allowed: false;
      denyReason: "missing_access_header_and_no_local_bypass" | "non_localhost_request_for_dev_bypass";
      branch: "deny";
      host: string;
      devEmailConfigured: boolean;
    };

function resolveAccessDecision(c: Context): AccessDecision {
  const host = (() => {
    try {
      return new URL(c.req.url).hostname.toLowerCase();
    } catch {
      return "unknown_host";
    }
  })();
  const fromAccess =
    headerValue(c, "cf-access-authenticated-user-email") ??
    headerValue(c, "Cf-Access-Authenticated-User-Email");
  if (fromAccess) {
    return {
      allowed: true,
      email: normalizeEmailLike(fromAccess),
      branch: "cf_access_header",
      host,
      devEmailConfigured: Boolean((c as any)?.env?.PA_DEV_EMAIL),
    };
  }

  // Local dev fallback: allow bypassing Access only on localhost and only when explicitly configured.
  const devEmail = (c as any)?.env?.PA_DEV_EMAIL;
  const devEmailConfigured = typeof devEmail === "string" && Boolean(devEmail.trim());
  const localhostRequest = isLocalhostRequest(c);
  if (devEmailConfigured && localhostRequest) {
    return {
      allowed: true,
      email: normalizeEmailLike(devEmail),
      branch: "localhost_dev_email",
      host,
      devEmailConfigured: true,
    };
  }

  if (devEmailConfigured && !localhostRequest) {
    return {
      allowed: false,
      branch: "deny",
      denyReason: "non_localhost_request_for_dev_bypass",
      host,
      devEmailConfigured: true,
    };
  }

  return {
    allowed: false,
    branch: "deny",
    denyReason: "missing_access_header_and_no_local_bypass",
    host,
    devEmailConfigured,
  };
}

export function getAccessEmail(c: Context): string | null {
  const decision = resolveAccessDecision(c);
  return decision.allowed ? decision.email : null;
}

export function requireAccess(c: Context): { email: string } {
  const logger = getLogger(c);
  const decision = resolveAccessDecision(c);
  logger.logMilestone("auth_access_evaluated", {
    auth_branch: decision.branch,
    auth_allowed: decision.allowed,
    auth_host: decision.host,
    auth_dev_email_configured: decision.devEmailConfigured,
    auth_deny_reason: decision.allowed ? null : decision.denyReason,
  });
  if (!decision.allowed) {
    const err = new Error("unauthorized");
    (err as any).status = 401;
    (err as any).details = `auth denied: ${decision.denyReason}; host=${decision.host}; devEmailConfigured=${decision.devEmailConfigured}`;
    logger.logWarn({
      eventType: "auth_denied",
      message: "Access denied by auth gate.",
      context: {
        auth_branch: decision.branch,
        auth_host: decision.host,
        auth_dev_email_configured: decision.devEmailConfigured,
        auth_deny_reason: decision.denyReason,
      },
    });
    throw err;
  }
  logger.logMilestone("auth_access_granted", {
    auth_branch: decision.branch,
    auth_host: decision.host,
    auth_dev_email_configured: decision.devEmailConfigured,
  });
  return { email: decision.email };
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
  const normalizedEmail = normalizeEmailLike(email);
  if (!isValidEmailFormat(normalizedEmail)) {
    const err = new Error(`Invalid email format: "${normalizedEmail}". Set PA_DEV_EMAIL like "me@example.com".`);
    (err as any).status = 400;
    throw err;
  }

  const cached = userIdCache.get(normalizedEmail);
  if (cached && cached.expiresAt > Date.now()) return cached.userId;

  const existing = await findAuthUserIdByEmail(db, normalizedEmail);
  if (existing) {
    userIdCache.set(normalizedEmail, { userId: existing, expiresAt: Date.now() + USER_ID_CACHE_TTL_MS });
    return existing;
  }

  const { data, error } = await db.auth.admin.createUser({ email: normalizedEmail, email_confirm: true });
  if (error) {
    // Possible race: created between list+create. Retry once.
    const retry = await findAuthUserIdByEmail(db, normalizedEmail);
    if (retry) {
      userIdCache.set(normalizedEmail, { userId: retry, expiresAt: Date.now() + USER_ID_CACHE_TTL_MS });
      return retry;
    }
    throw error;
  }

  const createdId = (data as any)?.user?.id as string | undefined;
  if (!createdId) throw new Error("Failed to resolve Supabase auth user id.");
  userIdCache.set(normalizedEmail, { userId: createdId, expiresAt: Date.now() + USER_ID_CACHE_TTL_MS });
  return createdId;
}

export async function requireAccessUser(c: Context, db: Db): Promise<{ email: string; userId: string }> {
  const { email } = requireAccess(c);
  const userId = await getOrCreateAuthUserId(db, email);
  return { email, userId };
}
