import type { AppContext } from "../router.js";
import { badRequest, ok } from "../lib/errors.js";
import { persistFrontendLog, type FrontendLogPayload } from "../lib/observability.js";

const MAX_OBSERVABILITY_PAYLOAD_BYTES = 16_384;

function isSupportedContentType(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("application/json") || normalized.includes("text/plain");
}

export async function handleFrontendObservability(request: Request, ctx: AppContext): Promise<Response> {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  const normalizedContentType = contentType.toLowerCase();
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (!isSupportedContentType(contentType)) {
    ctx.logger.logWarn({
      eventType: "frontend_observability_ingest_rejected",
      message: "Unsupported content type for frontend observability ingest.",
      context: {
        branch_taken: "deny_unsupported_content_type",
        deny_reason: "unsupported_content_type",
        content_type: contentType || null,
        content_length: Number.isFinite(contentLength) ? contentLength : null,
      },
    });
    throw badRequest("Expected JSON or plain-text JSON payload.");
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_OBSERVABILITY_PAYLOAD_BYTES) {
    ctx.logger.logWarn({
      eventType: "frontend_observability_ingest_rejected",
      message: "Frontend observability payload exceeded max length.",
      context: {
        branch_taken: "deny_payload_too_large",
        deny_reason: "payload_too_large",
        content_type: contentType || null,
        content_length: contentLength,
        max_payload_bytes: MAX_OBSERVABILITY_PAYLOAD_BYTES,
      },
    });
    throw badRequest("Observability payload too large.");
  }

  let parsedBody: unknown;
  try {
    if (normalizedContentType.includes("application/json")) {
      parsedBody = (await request.json()) as FrontendLogPayload | null;
    } else {
      const rawBody = await request.text();
      parsedBody = JSON.parse(rawBody) as FrontendLogPayload | null;
    }
  } catch (error) {
    ctx.logger.logWarn({
      eventType: "frontend_observability_ingest_rejected",
      message: "Frontend observability payload could not be parsed.",
      context: {
        branch_taken: "deny_invalid_json_payload",
        deny_reason: "invalid_json_payload",
        content_type: contentType || null,
        content_length: Number.isFinite(contentLength) ? contentLength : null,
        parse_error: error instanceof Error ? error.message : String(error),
      },
    });
    throw badRequest("Invalid observability payload.");
  }

  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    ctx.logger.logWarn({
      eventType: "frontend_observability_ingest_rejected",
      message: "Frontend observability payload was not an object.",
      context: {
        branch_taken: "deny_invalid_payload_shape",
        deny_reason: "payload_must_be_object",
        content_type: contentType || null,
        content_length: Number.isFinite(contentLength) ? contentLength : null,
        parsed_payload_type: Array.isArray(parsedBody) ? "array" : typeof parsedBody,
      },
    });
    throw badRequest("Invalid observability payload.");
  }

  await persistFrontendLog(ctx.env, parsedBody as FrontendLogPayload, request, ctx.executionCtx);
  return ok({ ok: true });
}
