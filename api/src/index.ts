import { Hono } from "hono";
import { z } from "zod";
import * as XLSX from "xlsx";
import { ParsedActionZ, type ParsedAction } from "./shared/model";
import { makeSupabase } from "./repo/supabase";
import { makePaRepo } from "./repo/paRepo";
import { requireAccess } from "./auth";
import type { Env } from "./env";
import { parseTranscript, canonicalizeActionTargets, refineUpdateDelete } from "./llm/parse";

function makeRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

app.use("/*", async (c, next) => {
  const requestId = makeRequestId();
  c.header("X-Request-Id", requestId);
  c.header("X-Worker", "yairb-pa-api");
  (c as any).requestId = requestId;
  try {
    return await next();
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    const { message, details } = extractErrorDetails(e);
    console.log(JSON.stringify({ type: "error", requestId, status, message, details }));
    const error =
      status === 401 ? "unauthorized" : status === 409 ? "conflict" : status === 400 ? "bad_request" : "internal_error";
    return c.json({ error, details, requestId }, status);
  }
});

app.get("/health", (c) => c.json({ ok: true }));

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
  requireAccess(c);
  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  return c.json({ lists: await repo.listListsForUi() });
});

app.get("/lists/:listId/items", async (c) => {
  requireAccess(c);
  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  const schema = await repo.loadSchemaRegistry();
  const items = await repo.readListItems(schema, c.req.param("listId"));
  return c.json({ items });
});

app.post("/lists/:listId/reorder", async (c) => {
  const { email } = requireAccess(c);
  const BodyZ = z
    .object({
      priority: z.number().int(),
      orderedIds: z.array(z.string().min(1)).min(1),
      expectedRevision: z.number().int().min(0),
    })
    .strict();
  const body = BodyZ.parse(await c.req.json());
  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
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
  requireAccess(c);
  const BodyZ = z.object({ transcript: z.string().min(1) }).strict();
  const body = BodyZ.parse(await c.req.json());
  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  const schema = await repo.loadSchemaRegistry();
  const requestId = (c as any).requestId as string | undefined;
  const provider = (c.env.PA_LLM_PROVIDER ?? "heuristic") === "openai" ? "openai" : "heuristic";
  let action = await parseTranscript(schema, body.transcript, {
    provider,
    openaiApiKey: c.env.OPENAI_API_KEY,
    openaiModel: c.env.OPENAI_MODEL,
    requestId,
  });
  let canonical = canonicalizeActionTargets(schema, action as any) as any;

  if (provider === "openai" && (canonical.type === "update_item" || canonical.type === "delete_item")) {
    const listId = String(canonical.listId ?? "").trim();
    if (listId && c.env.OPENAI_API_KEY) {
      const items = await repo.readListItems(schema, listId);
      const candidates = items.map((it: any) => ({ id: it.id, text: String(it.text ?? "") }));
      canonical = await refineUpdateDelete(schema, body.transcript, canonical, candidates, {
        openaiApiKey: c.env.OPENAI_API_KEY,
        openaiModel: c.env.OPENAI_MODEL,
        requestId,
      });
    }
  }

  return c.json({ action: canonical, parseError: null });
});

app.post("/commit", async (c) => {
  const { email } = requireAccess(c);
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

  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  const schema = await repo.loadSchemaRegistry();
  const canonical = canonicalizeActionTargets(schema, action as any) as ParsedAction;
  const deviceId = c.req.header("x-pa-device-id")?.trim() || "unknown_device";
  const updatedBy = `${email}_${deviceId}`;

  let result: any;
  switch (canonical.type) {
    case "append_item":
      result = await repo.appendItem(schema, canonical as any, canonical.fields, { updatedBy });
      break;
    case "update_item":
      result = await repo.updateItem(schema, canonical as any, canonical.itemId, canonical.patch, {
        expectedUpdatedAt: body.expected?.itemUpdatedAt,
        updatedBy,
      });
      break;
    case "delete_item":
      result = await repo.deleteItem(schema, canonical as any, canonical.itemId, {
        expectedUpdatedAt: body.expected?.itemUpdatedAt,
        updatedBy,
      });
      break;
    case "move_item":
      result = await repo.moveItem(schema, canonical.fromListId, canonical.toListId, canonical.itemId, { updatedBy });
      break;
    case "create_list":
      result = await repo.createList(schema, canonical as any);
      break;
    case "add_fields":
      result = await repo.addFields(schema, canonical as any, { updatedBy });
      break;
    default:
      return c.json({ error: "unsupported_action" }, 400);
  }

  return c.json({ ok: true, result });
});

app.get("/export/:listId.csv", async (c) => {
  requireAccess(c);
  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  const schema = await repo.loadSchemaRegistry();
  const listId = c.req.param("listId");
  if (!listId) return c.json({ error: "bad_request", details: "Missing listId." }, 400);
  const lists = await repo.listLists(schema);
  const def = lists.find((l) => l.id === listId) ?? null;
  if (!def) return c.json({ error: "not_found" }, 404);
  const items = await repo.readListItems(schema, listId);
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

app.get("/export/:listId.xlsx", async (c) => {
  requireAccess(c);
  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  const schema = await repo.loadSchemaRegistry();
  const listId = c.req.param("listId");
  if (!listId) return c.json({ error: "bad_request", details: "Missing listId." }, 400);
  const lists = await repo.listLists(schema);
  const def = lists.find((l) => l.id === listId) ?? null;
  if (!def) return c.json({ error: "not_found" }, 404);

  const items = await repo.readListItems(schema, listId);
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

export default app;
