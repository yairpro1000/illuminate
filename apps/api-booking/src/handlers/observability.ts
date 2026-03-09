import type { AppContext } from "../router.js";
import { badRequest, ok } from "../lib/errors.js";
import { persistFrontendLog, type FrontendLogPayload } from "../lib/observability.js";

export async function handleFrontendObservability(request: Request, ctx: AppContext): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (!contentType.toLowerCase().includes("application/json")) {
    throw badRequest("Expected JSON payload.");
  }
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    throw badRequest("Observability payload too large.");
  }

  const body = (await request.json()) as FrontendLogPayload | null;
  if (!body || typeof body !== "object") throw badRequest("Invalid observability payload.");

  await persistFrontendLog(ctx.env, body, request, ctx.executionCtx);
  return ok({ ok: true });
}
