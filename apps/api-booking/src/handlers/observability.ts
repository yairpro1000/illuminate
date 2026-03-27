import type { AppContext } from '../router.js';
import { badRequest, ok } from '../lib/errors.js';
import { persistFrontendLog } from '../lib/logger.js';

const MAX_FRONTEND_OBSERVABILITY_BYTES = 16_384;

function parseContentLength(request: Request): number | null {
  const raw = request.headers.get('content-length');
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function isSupportedContentType(contentType: string): boolean {
  return contentType.includes('application/json') || contentType.includes('text/plain');
}

function logFrontendObservabilityDecision(
  ctx: AppContext,
  branchTaken: string,
  result: 'allow' | 'deny',
  detail: Record<string, unknown> = {},
): void {
  const payload = {
    eventType: result === 'allow'
      ? 'frontend_observability_ingest_allowed'
      : 'frontend_observability_ingest_rejected',
    message: result === 'allow'
      ? 'Accepted frontend observability payload'
      : 'Rejected frontend observability payload',
    context: {
      branch_taken: branchTaken,
      result,
      path: '/api/observability/frontend',
      ...detail,
    },
  };
  if (result === 'allow') {
    ctx.logger.logInfo(payload);
    return;
  }
  ctx.logger.logWarn(payload);
}

export async function handleFrontendObservability(
  request: Request,
  ctx: AppContext,
): Promise<Response> {
  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  const contentLength = parseContentLength(request);

  ctx.logger.logInfo({
    eventType: 'frontend_observability_ingest_started',
    message: 'Evaluating frontend observability payload',
    context: {
      path: '/api/observability/frontend',
      content_type: contentType || null,
      content_length: contentLength,
      branch_taken: 'evaluate_frontend_observability_payload',
    },
  });

  if (!isSupportedContentType(contentType)) {
    logFrontendObservabilityDecision(ctx, 'deny_unsupported_content_type', 'deny', {
      deny_reason: 'unsupported_content_type',
      content_type: contentType || null,
      content_length: contentLength,
    });
    throw badRequest('Expected JSON or plain-text JSON payload.');
  }

  if (contentLength !== null && contentLength > MAX_FRONTEND_OBSERVABILITY_BYTES) {
    logFrontendObservabilityDecision(ctx, 'deny_payload_too_large', 'deny', {
      deny_reason: 'payload_too_large',
      content_type: contentType,
      content_length: contentLength,
      max_bytes: MAX_FRONTEND_OBSERVABILITY_BYTES,
    });
    throw badRequest('Observability payload too large.');
  }

  const rawBody = await request.text();
  try {
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    await persistFrontendLog(ctx.env, payload, request, ctx.executionCtx);
    logFrontendObservabilityDecision(ctx, 'allow_supported_payload', 'allow', {
      content_type: contentType,
      content_length: contentLength ?? rawBody.length,
    });
    return ok({ ok: true });
  } catch (error) {
    logFrontendObservabilityDecision(ctx, 'deny_invalid_json_payload', 'deny', {
      deny_reason: 'invalid_json_payload',
      content_type: contentType,
      content_length: contentLength ?? rawBody.length,
      parse_error: error instanceof Error ? error.message : String(error),
    });
    throw badRequest('Invalid observability payload.');
  }
}
