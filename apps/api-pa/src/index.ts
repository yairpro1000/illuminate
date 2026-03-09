import { Hono } from "hono";
import { z } from "zod";
import { Resend } from "resend";
import * as XLSX from "xlsx";
import { ParsedActionZ, type ParsedAction } from "./shared/model";
import { makeSupabase } from "./repo/supabase";
import { makePaRepo, type PaRepo } from "./repo/paRepo";
import { makeUndoRepo, type UndoSnapshot } from "./repo/undoRepo";
import { requireAccess, requireAccessUser } from "./auth";
import type { Env } from "./env";
import { parseTranscriptWithDebug, canonicalizeActionTargets, refineUpdateDelete } from "./llm/parse";
import { TranslateLangZ, translateWithOpenAI, refineTranslationWithOpenAI, TranslationPayloadZ } from "./llm/translate";
import { attachObservability, getLogger, getRequestId, persistFrontendLog } from "./observability";
import { headerByteLength, instrumentFetch } from "../../shared/observability/backend.js";

function extractErrorDetails(e: any): { message: string; details: string } {
  const message = typeof e?.message === "string" && e.message.trim() ? e.message.trim() : "Internal Server Error";
  const parts: string[] = [];
  if (typeof e?.details === "string" && e.details.trim()) parts.push(e.details.trim());
  if (typeof e?.hint === "string" && e.hint.trim()) parts.push(`hint: ${e.hint.trim()}`);
  if (typeof e?.code === "string" && e.code.trim()) parts.push(`code: ${e.code.trim()}`);
  const details = parts.length ? `${message} (${parts.join("; ")})` : message;
  return { message, details };
}

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (/[,"\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function xlsxCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function xlsxSheetName(raw: string) {
  const s = String(raw ?? "")
    .trim()
    .replace(/[\\/*?:\[\]]/g, " ")
    .slice(0, 31)
    .trim();
  return s || "Sheet1";
}

const app = new Hono<{ Bindings: Env }>().basePath("/api");

function parseConfiguredOrigins(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => v.replace(/\/+$/g, "")),
  );
}

function isAllowedCorsOrigin(env: Env, origin: string | null): origin is string {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const normalized = parsed.origin.replace(/\/+$/g, "");
  const host = parsed.hostname.toLowerCase();

  if (host === "letsilluminate.co" || host.endsWith(".letsilluminate.co")) return true;
  if (host === "localhost" || host === "127.0.0.1") return true;

  const configured = parseConfiguredOrigins(env.API_ALLOWED_ORIGINS);
  return configured.has(normalized);
}

function applyCorsHeaders(c: any, origin: string): void {
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  c.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-pa-device-id, x-request-id, x-correlation-id, cf-access-authenticated-user-email",
  );
  c.header("Vary", "Origin");
}

app.use("/*", async (c, next) => {
  const origin = c.req.header("origin") ?? null;

  if (c.req.method === "OPTIONS") {
    if (isAllowedCorsOrigin(c.env, origin)) {
      applyCorsHeaders(c, origin);
      return c.body(null, 204);
    }
    return c.body(null, 403);
  }

  await next();
  if (isAllowedCorsOrigin(c.env, origin)) {
    applyCorsHeaders(c, origin);
  }
});

function getListIdFromExportRouteParam(c: any, ext: "csv" | "xlsx") {
  function normalize(raw: unknown) {
    let s = String(raw ?? "").trim().toLowerCase();
    const suffix = `.${ext}`;
    while (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
    return s;
  }

  // Prefer parsing the URL path, since some routers treat `.csv`/`.xlsx` as part of the param.
  const path = typeof c?.req?.path === "string" ? c.req.path : "";
  const m = path.match(new RegExp(`(?:^|/)export/(.+)\\.${ext}$`));
  if (m?.[1]) {
    try {
      return normalize(decodeURIComponent(m[1]));
    } catch {
      return normalize(m[1]);
    }
  }

  const direct = typeof c?.req?.param === "function" ? c.req.param("listId") : "";
  if (direct) return normalize(direct);

  const dotted = typeof c?.req?.param === "function" ? c.req.param(`listId.${ext}`) : "";
  if (dotted) return normalize(dotted);
  return "";
}

app.use("/*", async (c, next) => {
  const startedAt = Date.now();
  const { logger } = attachObservability(c);
  const requestSizeBytes = headerByteLength(c.req.raw.headers);
  logger.logMilestone("incoming_request_received", {
    method: c.req.method,
    path: c.req.path,
  });

  try {
    await next();
    const status = c.res.status;
    logger.logRequest({
      method: c.req.method,
      url: c.req.url,
      path: c.req.path,
      statusCode: status,
      durationMs: Date.now() - startedAt,
      success: status < 500,
      requestSizeBytes,
      responseSizeBytes: headerByteLength(c.res.headers),
    });
    if (status < 500) {
      logger.logMilestone("response_completed", {
        status_code: status,
        path: c.req.path,
      });
    }
    return;
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    const { message, details } = extractErrorDetails(e);
    if (status >= 500) {
      logger.captureException({
        eventType: "uncaught_exception",
        message: details,
        error: e,
        context: {
          method: c.req.method,
          path: c.req.path,
          status_code: status,
        },
      });
    } else {
      logger.logWarn({
        eventType: "handled_exception",
        message: details,
        context: {
          method: c.req.method,
          path: c.req.path,
          status_code: status,
        },
      });
    }
    logger.logRequest({
      method: c.req.method,
      url: c.req.url,
      path: c.req.path,
      statusCode: status,
      durationMs: Date.now() - startedAt,
      success: false,
      requestSizeBytes,
    });
    const error =
      status === 401 ? "unauthorized" : status === 409 ? "conflict" : status === 400 ? "bad_request" : "internal_error";
    return c.json({ error, details, requestId: getRequestId(c) }, status);
  }
});

app.onError((e, c) => {
  const logger = getLogger(c);
  const status = typeof (e as any)?.status === "number" ? (e as any).status : 500;
  const { message, details } = extractErrorDetails(e);
  if (status >= 500) {
    logger.captureException({
      eventType: "uncaught_exception",
      message: details || message,
      error: e,
      context: {
        method: c.req.method,
        path: c.req.path,
        status_code: status,
      },
    });
  } else {
    logger.logWarn({
      eventType: "handled_exception",
      message: details || message,
      context: {
        method: c.req.method,
        path: c.req.path,
        status_code: status,
      },
    });
  }
  const error =
    status === 401 ? "unauthorized" : status === 409 ? "conflict" : status === 400 ? "bad_request" : "internal_error";
  return c.json({ error, details, requestId: getRequestId(c) }, status as any);
});

app.get("/health", (c) => c.json({ ok: true }));

app.post("/observability/frontend", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  const contentLength = Number.parseInt(c.req.header("content-length") ?? "0", 10);
  if (!contentType.toLowerCase().includes("application/json")) {
    return c.json({ error: "bad_request", details: "Expected JSON payload." }, 400);
  }
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return c.json({ error: "payload_too_large", details: "Observability payload too large." }, 413);
  }
  await persistFrontendLog(c, await c.req.json());
  return c.json({ ok: true });
});

// Booking/public/admin routes now live only in apps/api-booking.

app.get("/me", (c) => {
  const { email } = requireAccess(c);
  return c.json({ user: { email } });
});

app.get("/config", (c) => {
  requireAccess(c);
  const provider = c.env.PA_LLM_PROVIDER ?? "heuristic";
  const model = provider === "openai" ? c.env.OPENAI_MODEL ?? null : null;
  return c.json({ llmProvider: provider, llmModel: model });
});

app.get("/lists", async (c) => {
  getLogger(c).logMilestone("auth_resolved");
  const db = makeSupabase(c.env);
  const { userId } = await requireAccessUser(c, db);
  const repo = makePaRepo(db, userId);
  return c.json({ lists: await repo.listListsForUi() });
});

app.get("/lists/:listId/items", async (c) => {
  const db = makeSupabase(c.env);
  const { userId } = await requireAccessUser(c, db);
  const repo = makePaRepo(db, userId);
  const schema = await repo.loadSchemaRegistry();
  const items = await repo.readListItems(schema, c.req.param("listId"));
  return c.json({ items });
});

app.post("/lists/:listId/reorder", async (c) => {
  const db = makeSupabase(c.env);
  const { email, userId } = await requireAccessUser(c, db);
  const BodyZ = z
    .object({
      priority: z.number().int(),
      orderedIds: z.array(z.string().min(1)).min(1),
      expectedRevision: z.number().int().min(0),
    })
    .strict();
  const body = BodyZ.parse(await c.req.json());
  const repo = makePaRepo(db, userId);
  const schema = await repo.loadSchemaRegistry();
  const deviceId = c.req.header("x-pa-device-id")?.trim() || "unknown_device";
  const updatedBy = `${email}_${deviceId}`;
  const result = await repo.reorderWithinPriorityBucket(
    schema,
    c.req.param("listId"),
    body.priority,
    body.orderedIds,
    { expectedRevision: body.expectedRevision, updatedBy },
  );
  return c.json({ ok: true, result });
});

app.post("/parse", async (c) => {
  const logger = getLogger(c);
  const BodyZ = z.object({ transcript: z.string().min(1), forceLlm: z.boolean().optional() }).strict();
  const body = BodyZ.parse(await c.req.json());
  const db = makeSupabase(c.env);
  const { userId } = await requireAccessUser(c, db);
  const repo = makePaRepo(db, userId);
  const schema = await repo.loadSchemaRegistry();
  const requestId = (c as any).requestId as string | undefined;
  logger.logMilestone("input_validated", {
    flow: "pa_parse",
    transcript_chars: body.transcript.length,
  });
  const providerFromEnv = (c.env.PA_LLM_PROVIDER ?? "heuristic") === "openai" ? "openai" : "heuristic";
  const forceLlm = Boolean(body.forceLlm);
  const provider = forceLlm ? "openai" : providerFromEnv;
  let parseError: string | null = null;
  let canonical: any;
  let parseDebug: any = { requestId: requestId ?? null, providerRequested: provider, method: "unknown" };
  try {
    const parsed = await parseTranscriptWithDebug(schema, body.transcript, {
      provider,
      openaiApiKey: c.env.OPENAI_API_KEY,
      openaiModel: c.env.OPENAI_MODEL,
      requestId,
      logger,
      ...(forceLlm ? { skipFast: true } : {}),
    } as any);
    parseDebug = parsed.debug;
    canonical = canonicalizeActionTargets(schema, parsed.action as any) as any;

    if (parseDebug?.method === "openai" && (canonical.type === "update_item" || canonical.type === "delete_item")) {
      const listId = String(canonical.listId ?? "").trim();
      if (listId && c.env.OPENAI_API_KEY) {
        const items = await repo.readListItems(schema, listId);
        const candidates = items.map((it: any) => ({ id: it.id, text: String(it.text ?? "") }));
        canonical = await refineUpdateDelete(schema, body.transcript, canonical, candidates, {
          openaiApiKey: c.env.OPENAI_API_KEY,
          openaiModel: c.env.OPENAI_MODEL,
          requestId,
          logger,
        });
      }
    }
  } catch (e: any) {
    parseError = String(e?.message ?? e ?? "Parse failed");
    const fallbackListId = schema.lists.app ? "app" : Object.keys(schema.lists)[0] ?? "inbox";
    canonical = { type: "append_item", valid: false, confidence: 0, listId: fallbackListId, fields: { text: body.transcript } };
  }
  logger.logMilestone("provider_result_persisted", {
    flow: "pa_parse",
    parse_error: parseError,
    method: parseDebug?.method ?? "unknown",
  });

  return c.json({ action: canonical, parseError, parseDebug });
});

app.post("/translate", async (c) => {
  const logger = getLogger(c);
  requireAccess(c);
  const BodyZ = z.object({ input: z.string().min(1) }).strict();
  const body = BodyZ.parse(await c.req.json());
  const requestId = (c as any).requestId as string | undefined;

  const apiKey = c.env.OPENAI_API_KEY;
  if (!apiKey) return c.json({ error: "bad_request", details: "OPENAI_API_KEY is not set.", requestId }, 400);
  const model = c.env.OPENAI_MODEL ?? "gpt-4.1-mini";

  const allowedLanguages = TranslateLangZ.options;
  const translation = await translateWithOpenAI({
    apiKey,
    model,
    input: body.input,
    allowedLanguages,
    requestId,
    logger,
  });
  return c.json({ ok: true, translation });
});

app.post("/translate/refine", async (c) => {
  const logger = getLogger(c);
  requireAccess(c);
  const BodyZ = z
    .object({
      draft: TranslationPayloadZ,
      question: z.string().optional(),
    })
    .strict();
  const body = BodyZ.parse(await c.req.json());
  const requestId = (c as any).requestId as string | undefined;

  const apiKey = c.env.OPENAI_API_KEY;
  if (!apiKey) return c.json({ error: "bad_request", details: "OPENAI_API_KEY is not set.", requestId }, 400);
  const model = c.env.OPENAI_MODEL ?? "gpt-4.1-mini";

  const allowedLanguages = TranslateLangZ.options;
  const refined = await refineTranslationWithOpenAI({
    apiKey,
    model,
    draft: body.draft,
    question: body.question,
    allowedLanguages,
    requestId,
    logger,
  });
  return c.json({ ok: true, ...refined });
});

app.post("/commit", async (c) => {
  const logger = getLogger(c);
  const db = makeSupabase(c.env);
  const { email, userId } = await requireAccessUser(c, db);
  const BodyZ = z
    .object({
      action: z.unknown(),
      expected: z
        .object({
          itemUpdatedAt: z.string().min(1).optional(),
        })
        .optional(),
    })
    .strict();
  const body = BodyZ.parse(await c.req.json());
  const action = ParsedActionZ.parse(body.action) as ParsedAction;
  if (!action.valid) return c.json({ error: "invalid_action", details: "Action is not valid; refusing to commit." }, 400);

  const repo = makePaRepo(db, userId);
  const schema = await repo.loadSchemaRegistry();
  const canonical = canonicalizeActionTargets(schema, action as any) as ParsedAction;
  logger.logMilestone("input_validated", {
    flow: "pa_commit",
    action_type: canonical.type,
  });
  const deviceId = c.req.header("x-pa-device-id")?.trim() || "unknown_device";
  const updatedBy = `${email}_${deviceId}`;

  let result: any;
  let undoId: string | undefined;
  const undoRepo = makeUndoRepo(db);

  switch (canonical.type) {
    case "append_item":
      result = await repo.appendItem(schema, canonical as any, canonical.fields, { updatedBy });
      break;
    case "update_item": {
      result = await repo.updateItem(schema, canonical as any, canonical.itemId, canonical.patch, {
        expectedUpdatedAt: body.expected?.itemUpdatedAt,
        updatedBy,
      });
      undoId = crypto.randomUUID();
      const label = `Updated "${String((result.prev as any)?.text ?? "").slice(0, 50)}"`;
      await undoRepo.push({
        id: undoId,
        userId,
        label,
        snapshots: [{ listId: result.listId, action: "update_item", item: result.prev as any, patchedFields: result.patchedFields }],
      });
      break;
    }
    case "delete_item": {
      result = await repo.deleteItem(schema, canonical as any, canonical.itemId, {
        expectedUpdatedAt: body.expected?.itemUpdatedAt,
        updatedBy,
      });
      undoId = crypto.randomUUID();
      const label = `Deleted "${String((result.prev as any)?.text ?? "").slice(0, 50)}"`;
      await undoRepo.push({
        id: undoId,
        userId,
        label,
        snapshots: [{ listId: result.listId, action: "delete_item", item: result.prev as any }],
      });
      break;
    }
    case "batch": {
      const idActions = (canonical as any).actions.filter(
        (a: any) => a && typeof a === "object" && (a.type === "update_item" || a.type === "delete_item"),
      );
      const allItemIds = idActions.map((a: any) => a.itemId);
      const beforeImages = allItemIds.length > 0 ? await repo.readItemsByIds(allItemIds) : new Map();
      const snapshots: UndoSnapshot[] = [];
      for (const batchAction of (canonical as any).actions) {
        if (batchAction.type === "append_item") {
          await repo.appendItem(schema, { listId: batchAction.listId }, batchAction.fields, { updatedBy });
        } else if (batchAction.type === "update_item") {
          await repo.updateItem(schema, { listId: batchAction.listId }, batchAction.itemId, batchAction.patch, { updatedBy });
          const prev = beforeImages.get(batchAction.itemId);
          if (prev) snapshots.push({ listId: batchAction.listId, action: "update_item", item: prev.item as any, patchedFields: Object.keys(batchAction.patch) });
        } else if (batchAction.type === "delete_item") {
          await repo.deleteItem(schema, { listId: batchAction.listId }, batchAction.itemId, { updatedBy });
          const prev = beforeImages.get(batchAction.itemId);
          if (prev) snapshots.push({ listId: batchAction.listId, action: "delete_item", item: prev.item as any });
        }
      }
      if (snapshots.length > 0) {
        undoId = crypto.randomUUID();
        await undoRepo.push({ id: undoId, userId, label: (canonical as any).label, snapshots });
      }
      result = { ok: true };
      break;
    }
    case "move_item": {
      result = await repo.moveItem(schema, canonical.fromListId, canonical.toListId, canonical.itemId, { updatedBy });
      if ((result as any).moved) {
        undoId = crypto.randomUUID();
        const movedLabel = `Moved item to "${schema.lists[canonical.toListId]?.title ?? canonical.toListId}"`;
        await undoRepo.push({
          id: undoId,
          userId,
          label: movedLabel,
          snapshots: [{ listId: canonical.fromListId, action: "move_item", item: { id: canonical.itemId }, movedToListId: canonical.toListId }],
        });
      }
      break;
    }
    case "delete_list": {
      const deleteListId = (canonical as any).listId as string;
      const listTitle = schema.lists[deleteListId]?.title ?? deleteListId;
      const deleteListResult = await repo.deleteList(schema, deleteListId);
      if (deleteListResult.items.length > 0) {
        undoId = crypto.randomUUID();
        const label = `Deleted list "${listTitle}" (${deleteListResult.items.length} item${deleteListResult.items.length !== 1 ? "s" : ""})`;
        await undoRepo.push({
          id: undoId,
          userId,
          label,
          snapshots: deleteListResult.items.map((item) => ({
            listId: deleteListId,
            action: "delete_item" as const,
            item: item as any,
          })),
        });
      }
      result = { ok: true, deletedListId: deleteListId, itemCount: deleteListResult.items.length };
      break;
    }
    case "create_list":
      result = await repo.createList(schema, canonical as any);
      break;
    case "add_fields":
      result = await repo.addFields(schema, canonical as any, { updatedBy });
      break;
    case "remove_fields":
      result = await repo.removeFields(schema, canonical as any, { updatedBy });
      break;
    default:
      return c.json({ error: "unsupported_action" }, 400);
  }
  logger.logMilestone("provider_result_persisted", {
    flow: "pa_commit",
    action_type: canonical.type,
    undo_id: undoId ?? null,
  });

  return c.json({ ok: true, result, ...(undoId ? { undoId } : {}) });
});

app.get("/undo", async (c) => {
  const db = makeSupabase(c.env);
  const { userId } = await requireAccessUser(c, db);
  const undoRepo = makeUndoRepo(db);
  const entries = await undoRepo.list(userId);
  return c.json({ entries });
});

app.post("/undo", async (c) => {
  const logger = getLogger(c);
  const db = makeSupabase(c.env);
  const { email, userId } = await requireAccessUser(c, db);
  const BodyZ = z.object({ id: z.string().min(1), confirmed: z.boolean().default(false) }).strict();
  const body = BodyZ.parse(await c.req.json());

  const repo = makePaRepo(db, userId);
  const undoRepo = makeUndoRepo(db);
  const deviceId = c.req.header("x-pa-device-id")?.trim() || "unknown_device";
  const updatedBy = `${email}_${deviceId}`;

  const target = await undoRepo.get(body.id, userId);
  if (!target) return c.json({ error: "not_found", details: "Undo entry not found or already undone." }, 404);

  const targetItemIds = target.snapshots.map((s) => s.item.id);
  const conflicts = await undoRepo.findConflicts(target.createdAt, target.id, targetItemIds, userId);

  if (conflicts.length > 0 && !body.confirmed) {
    logger.logMilestone("fallback_triggered", {
      flow: "pa_undo",
      conflict_count: conflicts.length,
    });
    return c.json({ ok: false, conflicts: true, conflictEntries: conflicts });
  }

  // Apply conflicts newest-first, popping only the overlapping items from each
  const targetItemIdSet = new Set(targetItemIds);
  const sortedConflicts = [...conflicts].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  for (const conflict of sortedConflicts) {
    const conflictEntry = await undoRepo.get(conflict.id, userId);
    if (!conflictEntry) continue;
    const overlapping = conflictEntry.snapshots.filter((s) => targetItemIdSet.has(s.item.id));
    for (const snap of overlapping) {
      await applyUndoSnapshot(repo, snap, updatedBy);
    }
    await undoRepo.removeItemsFromEntry(conflict.id, overlapping.map((s) => s.item.id), userId);
  }

  // Apply the target undo
  for (const snap of target.snapshots) {
    await applyUndoSnapshot(repo, snap, updatedBy);
  }
  await undoRepo.delete(target.id, userId);
  logger.logMilestone("provider_result_persisted", {
    flow: "pa_undo",
    undo_id: target.id,
  });

  return c.json({ ok: true });
});

async function applyUndoSnapshot(repo: PaRepo, snap: UndoSnapshot, updatedBy: string) {
  if (snap.action === "delete_item") {
    await repo.upsertItem(snap.listId, snap.item as any, { updatedBy });
  } else if (snap.action === "update_item" && snap.patchedFields && snap.patchedFields.length > 0) {
    const restorePatch: Record<string, unknown> = {};
    for (const field of snap.patchedFields) {
      restorePatch[field] = (snap.item as any)[field];
    }
    await repo.patchItemRaw(snap.listId, snap.item.id, restorePatch, { updatedBy });
  } else if (snap.action === "move_item" && snap.movedToListId) {
    const schema = await repo.loadSchemaRegistry();
    await repo.moveItem(schema, snap.movedToListId, snap.listId, snap.item.id, { updatedBy });
  }
}

app.get("/export/:listId.csv", async (c) => {
  const listId = getListIdFromExportRouteParam(c, "csv");
  if (!listId) return c.json({ error: "bad_request", details: "Missing listId." }, 400);
  const db = makeSupabase(c.env);
  const { userId } = await requireAccessUser(c, db);
  const repo = makePaRepo(db, userId);
  const schema = await repo.loadSchemaRegistry();
  const lists = await repo.listLists(schema);
  const defEntry = lists.find((l) => l.id.toLowerCase() === listId) ?? null;
  if (!defEntry) return c.json({ error: "not_found", details: `Unknown listId "${listId}".` }, 404);
  const def = defEntry;
  const items = await repo.readListItems(schema, def.id);
  const fieldNames = Object.keys(def.fields);
  const headers = ["id", "createdAt", ...fieldNames];
  const lines: string[] = [];
  lines.push(headers.join(","));
  for (const it of items as any[]) {
    const row = headers.map((h) => csvEscape(it[h]));
    lines.push(row.join(","));
  }
  const csv = lines.join("\n") + "\n";
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${encodeURIComponent(listId)}.csv"`);
  return c.body(csv);
});

app.get("/export/csv/:listId", async (c) => {
  const listId = String(c.req.param("listId") ?? "").trim();
  if (!listId) return c.json({ error: "bad_request", details: "Missing listId." }, 400);
  const db = makeSupabase(c.env);
  const { userId } = await requireAccessUser(c, db);
  const repo = makePaRepo(db, userId);
  const schema = await repo.loadSchemaRegistry();
  const lists = await repo.listLists(schema);
  const defEntry = lists.find((l) => l.id.toLowerCase() === listId.toLowerCase()) ?? null;
  if (!defEntry) return c.json({ error: "not_found", details: `Unknown listId "${listId}".` }, 404);
  const def = defEntry;
  const items = await repo.readListItems(schema, def.id);
  const fieldNames = Object.keys(def.fields);
  const headers = ["id", "createdAt", ...fieldNames];
  const lines: string[] = [];
  lines.push(headers.join(","));
  for (const it of items as any[]) {
    const row = headers.map((h) => csvEscape(it[h]));
    lines.push(row.join(","));
  }
  const csv = lines.join("\n") + "\n";
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${encodeURIComponent(def.id)}.csv"`);
  return c.body(csv);
});

app.get("/export/:listId.xlsx", async (c) => {
  const listId = getListIdFromExportRouteParam(c, "xlsx");
  if (!listId) return c.json({ error: "bad_request", details: "Missing listId." }, 400);
  const db = makeSupabase(c.env);
  const { userId } = await requireAccessUser(c, db);
  const repo = makePaRepo(db, userId);
  const schema = await repo.loadSchemaRegistry();
  const lists = await repo.listLists(schema);
  const defEntry = lists.find((l) => l.id.toLowerCase() === listId) ?? null;
  if (!defEntry) return c.json({ error: "not_found", details: `Unknown listId "${listId}".` }, 404);
  const def = defEntry;

  const items = await repo.readListItems(schema, def.id);
  const fieldNames = Object.keys(def.fields);
  const headers = ["id", "createdAt", ...fieldNames];
  const rows: unknown[][] = [headers];
  for (const it of items as any[]) {
    rows.push(headers.map((h) => xlsxCell(it[h])));
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, xlsxSheetName(def.title || listId));
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;

  c.header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  c.header("Content-Disposition", `attachment; filename="${encodeURIComponent(listId)}.xlsx"`);
  return c.body(new Uint8Array(out));
});

app.get("/export/xlsx/:listId", async (c) => {
  const listId = String(c.req.param("listId") ?? "").trim();
  if (!listId) return c.json({ error: "bad_request", details: "Missing listId." }, 400);
  const db = makeSupabase(c.env);
  const { userId } = await requireAccessUser(c, db);
  const repo = makePaRepo(db, userId);
  const schema = await repo.loadSchemaRegistry();
  const lists = await repo.listLists(schema);
  const defEntry = lists.find((l) => l.id.toLowerCase() === listId.toLowerCase()) ?? null;
  if (!defEntry) return c.json({ error: "not_found", details: `Unknown listId "${listId}".` }, 404);
  const def = defEntry;

  const items = await repo.readListItems(schema, def.id);
  const fieldNames = Object.keys(def.fields);
  const headers = ["id", "createdAt", ...fieldNames];
  const rows: unknown[][] = [headers];
  for (const it of items as any[]) {
    rows.push(headers.map((h) => xlsxCell(it[h])));
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, xlsxSheetName(def.title || def.id));
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;

  c.header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  c.header("Content-Disposition", `attachment; filename="${encodeURIComponent(def.id)}.xlsx"`);
  return c.body(new Uint8Array(out));
});

app.post("/email", async (c) => {
  const logger = getLogger(c);
  requireAccess(c);
  const apiKey = c.env.RESEND_API_KEY;
  if (!apiKey) return c.json({ error: "bad_request", details: "RESEND_API_KEY is not set." }, 400);

  const BodyZ = z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    html: z.string().min(1),
  }).strict();
  const body = BodyZ.parse(await c.req.json());

  const resend = new Resend(apiKey);
  const startedAt = Date.now();
  let result: unknown;
  try {
    result = await resend.emails.send({
      from: "bookings@letsilluminate.co",
      to: body.to,
      replyTo: "hello@yairb.ch",
      subject: body.subject,
      html: body.html,
    });
    logger.logProviderCall({
      provider: "resend",
      operation: "send_email",
      success: true,
      durationMs: Date.now() - startedAt,
      context: {
        to: body.to,
        subject: body.subject,
        message_id: (result as any)?.data?.id ?? null,
      },
    });
  } catch (error) {
    logger.logProviderCall({
      provider: "resend",
      operation: "send_email",
      success: false,
      durationMs: Date.now() - startedAt,
      error,
      context: {
        to: body.to,
        subject: body.subject,
      },
    });
    throw error;
  }

  return c.json({ ok: true, result });
});

app.post("/speak", async (c) => {
  const logger = getLogger(c);
  requireAccess(c);
  const BodyZ = z.object({ text: z.string().min(1).max(4096), lang: z.string().optional() }).strict();
  const body = BodyZ.parse(await c.req.json());
  const lang = body.lang ?? "en-US";

  // Google Cloud TTS — supports all languages including Hebrew, German, Italian.
  // Enable "Cloud Text-to-Speech API" in Google Cloud Console, then:
  //   wrangler secret put GOOGLE_TTS_API_KEY
  const googleKey = c.env.GOOGLE_TTS_API_KEY;
  if (!googleKey) return c.json({ error: "bad_request", details: "GOOGLE_TTS_API_KEY is not set." }, 400);

  const ttsBody = {
    input: { text: body.text },
    voice: { languageCode: lang, ssmlGender: "NEUTRAL" },
    audioConfig: { audioEncoding: "MP3" },
  };
  const res = await instrumentFetch(logger, {
    provider: "google_tts",
    operation: "synthesize",
    method: "POST",
    url: `https://texttospeech.googleapis.com/v1/text:synthesize?key=${googleKey}`,
    headers: { "Content-Type": "application/json" },
    body: ttsBody,
  });
  if (!res.ok) {
    const err = await res.text();
    return c.json({ error: "tts_failed", details: err.slice(0, 300) }, 502);
  }
  const { audioContent } = await res.json() as { audioContent: string };
  const audioBytes = Uint8Array.from(atob(audioContent), (ch) => ch.charCodeAt(0));
  c.header("Content-Type", "audio/mpeg");
  return c.body(audioBytes);

  // MeloTTS via Cloudflare Workers AI (free-ish, but no Hebrew/German/Italian):
  // const meloLang = ({ en: "en", es: "es", fr: "fr" } as Record<string, string>)[lang.split("-")[0]] ?? "en";
  // const result = await (c.env.AI as any).run("@cf/myshell-ai/melotts", { prompt: body.text, lang: meloLang });
  // const audioBytes = Uint8Array.from(atob(result.audio), (ch) => ch.charCodeAt(0));
  // c.header("Content-Type", "audio/mpeg");
  // return c.body(audioBytes);

  // OpenAI TTS (pay-per-use, ~$15/1M chars, all languages):
  // const apiKey = c.env.OPENAI_API_KEY;
  // if (!apiKey) return c.json({ error: "bad_request", details: "OPENAI_API_KEY is not set." }, 400);
  // const res = await fetch("https://api.openai.com/v1/audio/speech", {
  //   method: "POST",
  //   headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
  //   body: JSON.stringify({ model: "tts-1", input: body.text, voice: "alloy", response_format: "mp3" }),
  // });
  // if (!res.ok) { const err = await res.text(); return c.json({ error: "tts_failed", details: err.slice(0, 300) }, 502); }
  // c.header("Content-Type", "audio/mpeg");
  // return c.body(await res.arrayBuffer());
});

export default app;
