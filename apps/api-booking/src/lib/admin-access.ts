import type { Env } from '../env.js';
import { forbidden, unauthorized } from './errors.js';

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

function getAccessJwt(request: Request): string | null {
  const token =
    request.headers.get('cf-access-jwt-assertion') ??
    request.headers.get('Cf-Access-Jwt-Assertion');
  return token?.trim() || null;
}

function decodeBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart<T>(input: string): T {
  const bytes = decodeBase64Url(input);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

interface AccessJwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface AccessJwtPayload {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
}

interface JwkKey {
  alg?: string;
  e?: string;
  kid?: string;
  kty?: string;
  n?: string;
  use?: string;
}

interface JwksResponse {
  keys?: JwkKey[];
}

const JWKS_CACHE_TTL_MS = 5 * 60_000;
const jwksCache = new Map<string, { expiresAt: number; keys: JwkKey[] }>();

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function isAllowedAudience(aud: string | string[] | undefined, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

function getJwksUrl(issuer: string): string {
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw unauthorized('Invalid Access token issuer');
  }

  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.cloudflareaccess.com')) {
    throw unauthorized('Invalid Access token issuer');
  }

  parsed.pathname = '/cdn-cgi/access/certs';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function fetchJwks(issuer: string): Promise<JwkKey[]> {
  const cached = jwksCache.get(issuer);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.keys;

  const response = await fetch(getJwksUrl(issuer));
  if (!response.ok) throw unauthorized('Unable to load Access signing keys');
  const body = await response.json() as JwksResponse;
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(issuer, { expiresAt: now + JWKS_CACHE_TTL_MS, keys });
  return keys;
}

async function verifyAccessJwt(token: string, expectedAudience: string): Promise<AccessJwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('Invalid Access token');

  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw unauthorized('Invalid Access token');
  const header = decodeJsonPart<AccessJwtHeader>(encodedHeader);
  const payload = decodeJsonPart<AccessJwtPayload>(encodedPayload);

  if (header.alg !== 'RS256' || !header.kid) throw unauthorized('Invalid Access token');
  if (!payload.iss || !isAllowedAudience(payload.aud, expectedAudience)) {
    throw unauthorized('Invalid Access token audience');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if ((typeof payload.nbf === 'number' && payload.nbf > nowSeconds) || (typeof payload.exp === 'number' && payload.exp <= nowSeconds)) {
    throw unauthorized('Access token expired');
  }

  const jwks = await fetchJwks(payload.iss);
  const jwk = jwks.find((key) => key.kid === header.kid);
  if (!jwk?.n || !jwk.e || jwk.kty !== 'RSA') throw unauthorized('Unable to verify Access token');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'RSA',
      alg: jwk.alg ?? 'RS256',
      n: jwk.n,
      e: jwk.e,
      ext: true,
    } satisfies JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    decodeBase64Url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw unauthorized('Invalid Access token signature');

  return payload;
}

function isLocalhostRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export async function requireAdminAccess(request: Request, env: Env): Promise<{ email: string }> {
  // TEMPORARY TESTING BYPASS:
  // When ADMIN_AUTH_DISABLED=true, admin routes are intentionally left open to
  // unblock manual testing. Do not leave this enabled in production.
  if (isTruthy(env.ADMIN_AUTH_DISABLED)) {
    return { email: 'admin-auth-disabled@local' };
  }

  const accessAud = env.CLOUDFLARE_ACCESS_AUD?.trim();
  const accessEmail = getAccessEmail(request);
  const allowlist = parseAllowlist(env.ADMIN_ALLOWED_EMAILS);

  if (accessAud) {
    const token = getAccessJwt(request);
    if (!token) throw unauthorized('Admin authentication required');
    const payload = await verifyAccessJwt(token, accessAud);
    const email = typeof payload.email === 'string' ? normalizeEmail(payload.email) : null;
    if (!email) throw unauthorized('Admin authentication required');
    if (allowlist.size > 0 && !allowlist.has(email)) {
      throw forbidden('Admin access denied');
    }
    return { email };
  }

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
