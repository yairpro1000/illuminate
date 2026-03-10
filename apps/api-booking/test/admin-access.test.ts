import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireAdminAccess } from '../src/lib/admin-access.js';
import { makeEnv } from './admin-helpers.js';

function toBase64Url(input: string | Uint8Array): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function makeAccessJwt(payloadOverrides: Record<string, unknown> = {}) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );

  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const header = { alg: 'RS256', kid: 'kid-1', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://team.cloudflareaccess.com',
    aud: 'aud-123',
    email: 'admin@example.com',
    iat: now,
    nbf: now - 10,
    exp: now + 300,
    ...payloadOverrides,
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );

  return {
    token: `${encodedHeader}.${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`,
    jwks: {
      keys: [{
        ...publicJwk,
        kid: 'kid-1',
        alg: 'RS256',
        use: 'sig',
      }],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requireAdminAccess', () => {
  it('returns 401 when Access JWT is missing', async () => {
    const env = makeEnv({
      CLOUDFLARE_ACCESS_AUD: 'aud-123',
      ADMIN_ALLOWED_EMAILS: 'admin@example.com',
    });

    await expect(requireAdminAccess(new Request('https://api.local/api/admin/events'), env))
      .rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
  });

  it('accepts a valid Access JWT for an allowed email', async () => {
    const { token, jwks } = await makeAccessJwt({ iss: 'https://team-allow.cloudflareaccess.com' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const env = makeEnv({
      CLOUDFLARE_ACCESS_AUD: 'aud-123',
      ADMIN_ALLOWED_EMAILS: 'admin@example.com',
    });
    const req = new Request('https://api.local/api/admin/events', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });

    await expect(requireAdminAccess(req, env)).resolves.toEqual({ email: 'admin@example.com' });
  });

  it('returns 403 when the Access JWT email is not allowed', async () => {
    const { token, jwks } = await makeAccessJwt({ iss: 'https://team-deny.cloudflareaccess.com' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const env = makeEnv({
      CLOUDFLARE_ACCESS_AUD: 'aud-123',
      ADMIN_ALLOWED_EMAILS: 'other@example.com',
    });
    const req = new Request('https://api.local/api/admin/events', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });

    await expect(requireAdminAccess(req, env))
      .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });
});
