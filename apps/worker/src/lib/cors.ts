const ALLOWED_HEADERS = 'Content-Type, Authorization';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
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
export function getAllowedOrigin(request: Request, siteUrl: string): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;

  const allowed = [
    siteUrl,
    'http://localhost:8080',
    'http://localhost:5173',
    'http://127.0.0.1:8080',
  ];

  return allowed.includes(origin) ? origin : null;
}
