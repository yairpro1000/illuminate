import { Hono } from "hono";
import { z } from "zod";
import { ParsedActionZ, type ParsedAction } from "../../pa-v1/shared/model";
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

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (/[,"\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

const app = new Hono<{ Bindings: Env }>();

app.use("/pa/*", async (c, next) => {
  const requestId = makeRequestId();
  c.header("X-Request-Id", requestId);
  (c as any).requestId = requestId;
  try {
    return await next();
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    const message = typeof e?.message === "string" ? e.message : String(e);
    console.log(JSON.stringify({ type: "error", requestId, status, message }));
    return c.json({ error: status === 401 ? "unauthorized" : "internal_error", details: message }, status);
  }
});

app.get("/pa/health", (c) => c.json({ ok: true }));

app.get("/pa/me", (c) => {
  const { email } = requireAccess(c);
  return c.json({ user: { email } });
});

app.get("/pa/config", (c) => {
  requireAccess(c);
  const provider = c.env.PA_LLM_PROVIDER ?? "heuristic";
  const model = provider === "openai" ? c.env.OPENAI_MODEL ?? null : null;
  return c.json({ llmProvider: provider, llmModel: model });
});

app.get("/pa/lists", async (c) => {
  requireAccess(c);
  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  const schema = await repo.loadSchemaRegistry();
  return c.json({ lists: await repo.listLists(schema) });
});

app.get("/pa/lists/:listId/items", async (c) => {
  requireAccess(c);
  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  const schema = await repo.loadSchemaRegistry();
  const items = await repo.readListItems(schema, c.req.param("listId"));
  return c.json({ items });
});

app.post("/pa/lists/:listId/reorder", async (c) => {
  requireAccess(c);
  const BodyZ = z.object({ priority: z.number().int(), orderedIds: z.array(z.string().min(1)).min(1) }).strict();
  const body = BodyZ.parse(await c.req.json());
  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  const schema = await repo.loadSchemaRegistry();
  const result = await repo.reorderWithinPriorityBucket(schema, c.req.param("listId"), body.priority, body.orderedIds);
  return c.json({ ok: true, result });
});

app.post("/pa/parse", async (c) => {
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

app.post("/pa/commit", async (c) => {
  requireAccess(c);
  const BodyZ = z.object({ action: z.unknown() }).strict();
  const body = BodyZ.parse(await c.req.json());
  const action = ParsedActionZ.parse(body.action) as ParsedAction;
  if (!action.valid) return c.json({ error: "invalid_action", details: "Action is not valid; refusing to commit." }, 400);

  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  const schema = await repo.loadSchemaRegistry();
  const canonical = canonicalizeActionTargets(schema, action as any) as ParsedAction;

  let result: any;
  switch (canonical.type) {
    case "append_item":
      result = await repo.appendItem(schema, canonical as any, canonical.fields);
      break;
    case "update_item":
      result = await repo.updateItem(schema, canonical as any, canonical.itemId, canonical.patch);
      break;
    case "delete_item":
      result = await repo.deleteItem(schema, canonical as any, canonical.itemId);
      break;
    case "move_item":
      result = await repo.moveItem(schema, canonical.fromListId, canonical.toListId, canonical.itemId);
      break;
    case "create_list":
      result = await repo.createList(schema, canonical as any);
      break;
    case "add_fields":
      result = await repo.addFields(schema, canonical as any);
      break;
    default:
      return c.json({ error: "unsupported_action" }, 400);
  }

  return c.json({ ok: true, result });
});

app.get("/pa/export/:listId.csv", async (c) => {
  requireAccess(c);
  const db = makeSupabase(c.env);
  const repo = makePaRepo(db);
  const schema = await repo.loadSchemaRegistry();
  const listId = c.req.param("listId");
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

export default app;
