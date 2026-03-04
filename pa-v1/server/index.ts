import path from "node:path";
import express from "express";
import session from "express-session";
import fs from "node:fs";
import { z } from "zod";
import { ParsedActionZ } from "../shared/model";
import { requireAuth, verifyLogin } from "./auth";
import { loadEnvFromFile } from "./env";
import { commitAction } from "./domain/commit";
import { exportListCsv, exportListXlsx, normalizeItemsForUi } from "./domain/export";
import { listLists, readListItems, reorderWithinPriorityBucket } from "./domain/lists";
import { makeRequestId, logEvent, shouldLogLlmText, textPreview } from "./logger";
import { parseTranscript, canonicalizeActionTargets } from "./llm/parse";
import { loadSchemaRegistry } from "./storage/schema";

loadEnvFromFile();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  (req as any).requestId = makeRequestId();
  res.setHeader("X-Request-Id", (req as any).requestId);
  next();
});

function asyncRoute(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>,
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.use(
  session({
    secret: process.env.PA_SESSION_SECRET ?? "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  }),
);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/config", (_req, res) => {
  const provider = process.env.PA_LLM_PROVIDER ?? "heuristic";
  const model =
    provider === "openai"
      ? process.env.OPENAI_MODEL ?? null
      : provider === "ollama"
        ? process.env.OLLAMA_MODEL ?? null
        : null;
  res.json({ llmProvider: provider, llmModel: model });
});

app.post("/api/auth/login", async (req, res) => {
  const BodyZ = z.object({ username: z.string(), password: z.string() }).strict();
  const body = BodyZ.parse(req.body);
  try {
    const ok = await verifyLogin(body.username, body.password);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });
    req.session.user = { username: body.username };
    return res.json({ ok: true, username: body.username });
  } catch (e: any) {
    return res.status(500).json({ error: "auth_not_configured", details: String(e?.message ?? e) });
  }
});

app.post(
  "/api/auth/logout",
  requireAuth,
  asyncRoute(async (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
  }),
);

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user ?? null });
});

app.get(
  "/api/lists",
  requireAuth,
  asyncRoute(async (_req, res) => {
  const schema = await loadSchemaRegistry();
  res.json({ lists: await listLists(schema) });
  }),
);

app.get(
  "/api/lists/:listId/items",
  requireAuth,
  asyncRoute(async (req, res) => {
  const schema = await loadSchemaRegistry();
  const items = await readListItems(schema, req.params.listId);
  res.json({ items: normalizeItemsForUi(items) });
  }),
);

app.post(
  "/api/lists/:listId/reorder",
  requireAuth,
  asyncRoute(async (req, res) => {
  const BodyZ = z
    .object({
      priority: z.number().int(),
      orderedIds: z.array(z.string().min(1)).min(1),
    })
    .strict();
  const body = BodyZ.parse(req.body);
  const schema = await loadSchemaRegistry();
  const result = await reorderWithinPriorityBucket(schema, req.params.listId, body.priority, body.orderedIds);
  res.json({ ok: true, result });
  }),
);

app.post(
  "/api/parse",
  requireAuth,
  asyncRoute(async (req, res) => {
  const BodyZ = z.object({ transcript: z.string().min(1) }).strict();
  const body = BodyZ.parse(req.body);
  const schema = await loadSchemaRegistry();
  const logFull = shouldLogLlmText();
  await logEvent("info", {
    type: "parse_http",
    requestId: (req as any).requestId,
    transcriptChars: body.transcript.length,
    transcriptPreview: textPreview(body.transcript, 200),
    ...(logFull ? { transcript: body.transcript } : {}),
  });
  try {
    const requestId = (req as any).requestId as string;
    const action = await parseTranscript(schema, body.transcript, { requestId });
    res.json({ action });
  } catch (e: any) {
    await logEvent("warn", {
      type: "parse_failed",
      requestId: (req as any).requestId,
      message: String(e?.message ?? e),
      transcriptPreview: textPreview(body.transcript, 200),
      ...(logFull ? { transcript: body.transcript } : {}),
    });
    const fallbackListId = schema.lists.app ? "app" : (Object.keys(schema.lists)[0] ?? "inbox");
    res.json({
      action: {
        type: "append_item",
        valid: false,
        confidence: 0,
        listId: fallbackListId,
        fields: { text: body.transcript },
      },
      parseError: String(e?.message ?? e),
    });
  }
  }),
);

app.post(
  "/api/commit",
  requireAuth,
  asyncRoute(async (req, res) => {
  const bodyAction = req.body?.action ?? req.body;
  const action = ParsedActionZ.parse(bodyAction);
  const schema = await loadSchemaRegistry();
  const canonical = canonicalizeActionTargets(schema, action);
  const result = await commitAction(schema, canonical);
  await logEvent("info", {
    type: "commit_ok",
    requestId: (req as any).requestId,
    actionType: action.type,
    listId: (canonical as any).listId ?? null,
  });
  res.json({ ok: true, result });
  }),
);

app.get(
  "/api/export/:listId.csv",
  requireAuth,
  asyncRoute(async (req, res) => {
  const schema = await loadSchemaRegistry();
  const listId = req.params.listId;
  const csv = await exportListCsv(schema, listId);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${listId}.csv"`);
  res.send(csv);
  }),
);

app.get(
  "/api/export/:listId.xlsx",
  requireAuth,
  asyncRoute(async (req, res) => {
  const schema = await loadSchemaRegistry();
  const listId = req.params.listId;
  const buf = await exportListXlsx(schema, listId);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${listId}.xlsx"`);
  res.send(buf);
  }),
);

const distDir = path.resolve(__dirname, "..", "..", "web", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof err?.status === "number" ? err.status : 400;
  logEvent("error", { type: "api_error", status, message: String(err?.message ?? err) }).catch(() => {});
  res.status(status).json({ error: "request_failed", details: String(err?.message ?? err) });
});

const port = Number(process.env.PA_PORT ?? 8787);
const server = app.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`PA V1 API running on http://127.0.0.1:${port}`);
});
server.on("error", (err: any) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start API server:", err?.message ?? err);
  if (err?.code === "EADDRINUSE") {
    // eslint-disable-next-line no-console
    console.error(`Port ${port} is already in use. Try: PA_PORT=8788 npm run dev`);
  }
  process.exit(1);
});
