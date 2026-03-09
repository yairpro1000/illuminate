const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'x-request-id',
  'x-correlation-id',
  'cf-access-authenticated-user-email',
  'Cf-Access-Authenticated-User-Email',
].join(', ');
const ALLOWED_METHODS = 'GET, POST, PATCH, OPTIONS';

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

export function handlePreflight(origin: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export function addCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** Returns the request origin if it should be allowed, or null. */
export function getAllowedOrigin(
  request: Request,
  siteUrl: string,
  configuredOrigins?: string,
): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }

  const normalizedOrigin = parsed.origin.replace(/\/+$/, '');
  const host = parsed.hostname.toLowerCase();
  const normalizedConfigured = new Set(
    String(configuredOrigins ?? '')
      .split(',')
      .map((value) => value.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );

  if (normalizedOrigin === siteUrl.replace(/\/+$/, '')) return normalizedOrigin;
  if (host === 'letsilluminate.co' || host.endsWith('.letsilluminate.co')) return normalizedOrigin;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return normalizedOrigin;
  if (normalizedConfigured.has(normalizedOrigin)) return normalizedOrigin;
  return null;
}
