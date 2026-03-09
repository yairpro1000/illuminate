import type { Env } from '../env.js';
import { unauthorized } from './errors.js';

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    String(raw ?? '')
      .split(/[,\n;]+/g)
      .map((value) => value.trim())
      .filter(Boolean)
      .map(normalizeEmail),
  );
}

function getAccessEmail(request: Request): string | null {
  const direct =
    request.headers.get('cf-access-authenticated-user-email') ??
    request.headers.get('Cf-Access-Authenticated-User-Email');
  if (direct?.trim()) return normalizeEmail(direct);
  return null;
}

function isLocalhostRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function requireAdminAccess(request: Request, env: Env): { email: string } {
  const accessEmail = getAccessEmail(request);
  const allowlist = parseAllowlist(env.ADMIN_ALLOWED_EMAILS);

  if (accessEmail) {
    if (allowlist.size === 0 || allowlist.has(accessEmail)) {
      return { email: accessEmail };
    }
    throw unauthorized('Admin access denied');
  }

  const devEmail = env.ADMIN_DEV_EMAIL?.trim();
  if (devEmail && isLocalhostRequest(request)) {
    const normalized = normalizeEmail(devEmail);
    if (allowlist.size === 0 || allowlist.has(normalized)) {
      return { email: normalized };
    }
  }

  throw unauthorized('Admin authentication required');
}
