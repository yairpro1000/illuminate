export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(message: string, code = 'BAD_REQUEST'): ApiError {
  return new ApiError(400, code, message);
}

export function notFound(message = 'Not found'): ApiError {
  return new ApiError(404, 'NOT_FOUND', message);
}

export function gone(message: string): ApiError {
  return new ApiError(410, 'GONE', message);
}

export function methodNotAllowed(): ApiError {
  return new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}

export function unauthorized(message = 'Unauthorized'): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, 'CONFLICT', message);
}

export function internalError(message = 'Internal server error'): ApiError {
  return new ApiError(500, 'INTERNAL_ERROR', message);
}

// ── Response helpers ──────────────────────────────────────────────────────────

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function ok(body: unknown): Response {
  return jsonResponse(body, 200);
}

export function created(body: unknown): Response {
  return jsonResponse(body, 201);
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return jsonResponse({ error: err.code, message: err.message }, err.statusCode);
  }
  console.error('[worker] Unhandled error:', err);
  return jsonResponse({ error: 'INTERNAL_ERROR', message: 'Internal server error' }, 500);
}
