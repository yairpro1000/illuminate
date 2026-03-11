/** Generates a cryptographically random 32-byte base64url token. */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** SHA-256 hex hash of a raw token string. Store this in the DB, never the raw token. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time-ish comparison of two hex hashes. */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8(message));
  return base64url(new Uint8Array(sig));
}

export async function createAdminManageToken(
  bookingId: string,
  secret: string,
  expiresAtIso: string,
): Promise<string> {
  const exp = Math.floor(new Date(expiresAtIso).getTime() / 1000);
  const nonce = generateToken().slice(0, 16);
  const payload = `am1.${bookingId}.${exp}.${nonce}`;
  const sig = await hmacSha256(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyAdminManageToken(
  token: string,
  secret: string,
): Promise<{ bookingId: string; exp: number } | null> {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [version, bookingId, expRaw, nonce, signature] = parts;
  if (version !== 'am1' || !bookingId || !nonce || !signature) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  const payload = `am1.${bookingId}.${exp}.${nonce}`;
  const expected = await hmacSha256(secret, payload);
  const expectedBytes = base64urlToBytes(expected);
  const actualBytes = base64urlToBytes(signature);
  if (expectedBytes.length !== actualBytes.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedBytes.length; i++) diff |= expectedBytes[i] ^ actualBytes[i];
  if (diff !== 0) return null;
  if (Math.floor(Date.now() / 1000) > exp) return null;
  return { bookingId, exp };
}
