import type { ParsedAction, SchemaRegistry } from "../../shared/model";
import { ParsedActionZ } from "../../shared/model";
import { resolveListId, sanitizeListId } from "../storage/schema";
import { logEvent, shouldLogLlmText, textPreview } from "../logger";
import { readListItems } from "../domain/lists";
import { isUuidLike, itemExists } from "../domain/itemId";

type Provider = "heuristic" | "openai" | "ollama";

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
}

function heuristicParse(schema: SchemaRegistry, transcript: string): ParsedAction {
  const t = transcript.trim();
  const lower = t.toLowerCase();

  const createMatch =
    lower.match(/^create (a )?new list( called)? (?<title>.+)$/) ??
    lower.match(/^new list( called)? (?<title>.+)$/);
  if (createMatch?.groups?.title) {
    const title = createMatch.groups.title.trim();
    const listId = slugify(title) || "new-list";
    return { type: "create_list", valid: true, confidence: 0.55, title, listId };
  }

  const addFieldsMatch = lower.match(
    /^add fields? (?<fields>.+) to (list )?(?<list>.+)$/i,
  );
  if (addFieldsMatch?.groups?.fields && addFieldsMatch?.groups?.list) {
    const fields = addFieldsMatch.groups.fields
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 10);
    return {
      type: "add_fields",
      valid: true,
      confidence: 0.45,
      target: addFieldsMatch.groups.list.trim(),
      fieldsToAdd: fields.map((name) => ({ name, type: "string", nullable: true })),
    };
  }

  // Default: append item to "app" (or first list).
  const fallbackListId = schema.lists.app ? "app" : (Object.keys(schema.lists)[0] ?? "inbox");
  return {
    type: "append_item",
    valid: true,
    confidence: 0.35,
    listId: fallbackListId,
    fields: { text: t },
  };
}

function fallbackListId(schema: SchemaRegistry) {
  return schema.lists.app ? "app" : (Object.keys(schema.lists)[0] ?? "inbox");
}

function normalizeRawAction(schema: SchemaRegistry, transcript: string, raw: any) {
  const base = raw && typeof raw === "object" ? { ...raw } : {};

  if (base.type === "create_list") {
    // create_list doesn't target an existing list, so don't force fallback listId/invalid.
    // Ensure a minimal usable shape.
    if (typeof base.title !== "string" || base.title.trim() === "") {
      base.valid = false;
      base.confidence = 0;
      if (typeof base.title !== "string") base.title = transcript.trim();
    } else {
      if (typeof base.valid !== "boolean") base.valid = true;
      if (typeof base.confidence !== "number" || !Number.isFinite(base.confidence)) base.confidence = 0.55;
    }
    return base;
  }

  if (base.type === "append_item") {
    // Some models return `{ text: "..." }` at the root; normalize to `fields.text`.
    if (base.fields === undefined && typeof (base as any).text === "string") {
      base.fields = { text: (base as any).text };
      delete (base as any).text;
    }
    // Some models mistakenly put list targeting inside `fields`. Lift it.
    if (base.fields && typeof base.fields === "object") {
      const fieldsObj = base.fields as Record<string, unknown>;
      if (!base.listId && typeof fieldsObj.listId === "string" && fieldsObj.listId.trim() !== "") {
        base.listId = fieldsObj.listId;
        delete fieldsObj.listId;
      }
      if (!base.target && typeof fieldsObj.target === "string" && fieldsObj.target.trim() !== "") {
        base.target = fieldsObj.target;
        delete fieldsObj.target;
      }
    }
    if (base.fields === undefined && base.item !== undefined) {
      base.fields = base.item;
      delete base.item;
    }
    if (!base.listId && !base.target) base.listId = fallbackListId(schema);
    if (!base.fields || typeof base.fields !== "object") base.fields = { text: transcript };
    return base;
  }

  if (base.type === "update_item") {
    if (base.patch && typeof base.patch === "object") {
      // Some models incorrectly put list targeting inside `patch`. Lift it.
      const patchObj = base.patch as Record<string, unknown>;
      if (!base.listId && typeof patchObj.listId === "string" && patchObj.listId.trim() !== "") {
        base.listId = patchObj.listId;
        delete patchObj.listId;
      }
      if (!base.target && typeof patchObj.target === "string" && patchObj.target.trim() !== "") {
        base.target = patchObj.target;
        delete patchObj.target;
      }

      // Some models return `{ patch: { fields: { ... } } }`; flatten it.
      if (patchObj.fields && typeof patchObj.fields === "object") {
        const fields = patchObj.fields as Record<string, unknown>;
        delete patchObj.fields;
        base.patch = { ...patchObj, ...fields };
      } else {
        base.patch = patchObj;
      }
    }

    // If list target is missing, keep schema-valid but force user intervention.
    if (!base.listId && !base.target) {
      base.listId = fallbackListId(schema);
      base.valid = false;
      base.confidence = 0;
    }

    // For safety: update_item should only be considered valid when itemId is a UUID.
    if (typeof base.itemId === "string" && !isUuidLike(base.itemId)) {
      base.valid = false;
      base.confidence = 0;
    }
    return base;
  }

  if (base.type === "delete_item") {
    // Some models incorrectly put list targeting inside `patch` or other nested objects; we only support top-level.
    if (!base.listId && !base.target) {
      base.listId = fallbackListId(schema);
      base.valid = false;
      base.confidence = 0;
    }

    // For safety: delete_item should only be considered valid when itemId is a UUID.
    if (typeof base.itemId === "string" && !isUuidLike(base.itemId)) {
      base.valid = false;
      base.confidence = 0;
    }
    return base;
  }

  // For other actions: if list target is missing, keep schema-valid but force user intervention.
  if (base.type && !base.listId && !base.target) {
    base.listId = fallbackListId(schema);
    base.valid = false;
    base.confidence = 0;
  }

  return base;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "do",
  "edit",
  "for",
  "from",
  "i",
  "in",
  "is",
  "item",
  "it",
  "list",
  "me",
  "of",
  "on",
  "or",
  "please",
  "remove",
  "set",
  "the",
  "this",
  "to",
  "update",
  "with",
]);

function tokens(input: string) {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .slice(0, 20);
}

function pickCandidates(items: Array<{ id: string; text: string }>, query: string, max = 40) {
  if (items.length <= max) return items;

  const qTokens = tokens(query);
  const scored = items.map((it) => {
    const t = it.text.toLowerCase();
    let score = 0;
    if (query.trim() && t === query.trim().toLowerCase()) score += 100;
    if (query.trim() && t.includes(query.trim().toLowerCase())) score += 20;
    for (const tok of qTokens) if (t.includes(tok)) score += 5;
    return { it, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored.filter((s) => s.score > 0).slice(0, max).map((s) => s.it);
  if (best.length >= Math.min(8, max)) return best;

  // Fallback: last N (often most recent) if scoring doesn't help.
  return items.slice(-max);
}

async function openAiParse(
  schema: SchemaRegistry,
  transcript: string,
  opts?: { requestId?: string },
): Promise<ParsedAction> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

  const lists = Object.entries(schema.lists).map(([id, def]) => ({
    id,
    title: def.title,
    aliases: def.aliases ?? [],
    fields: def.fields,
  }));

  const system = [
    "You are a parser that converts a transcript into ONE strict JSON action object.",
    "Output MUST be valid JSON only (no markdown, no prose).",
    "Always include: type, valid, confidence.",
    "If you are unsure, set valid=false and confidence low.",
    "Allowed types: append_item, update_item, delete_item, create_list, add_fields.",
    "For list targeting: use listId when you can, else use target (title/alias).",
    "For append_item: include fields with at least text.",
    "IMPORTANT: listId/target must be top-level fields on the action, not inside `fields`.",
    "For update_item/delete_item: include itemId and patch (for update_item).",
    "IMPORTANT: itemId should be the item's UUID if known; otherwise use a text query (e.g. the item's current text) and lower confidence.",
    "IMPORTANT: for update_item, patch must be a FLAT object of list fields (e.g. {\"text\":\"...\"}); do not nest inside `fields`.",
    "IMPORTANT: do not put listId/target inside patch; put them top-level on the action.",
    "For create_list: include title, optional listId, optional fields (schema).",
    "For add_fields: include listId/target and fieldsToAdd[] with {name,type,default?,nullable?}.",
    "Allowed field types for add_fields: string, int, boolean, float, date, time, json.",
  ].join("\n");

  const user = JSON.stringify({ transcript, availableLists: lists });
  const logFull = shouldLogLlmText();

  await logEvent("info", {
    type: "llm_request",
    requestId: opts?.requestId ?? null,
    provider: "openai",
    model,
    transcriptChars: transcript.length,
    transcriptPreview: textPreview(transcript, 200),
    ...(logFull ? { transcript } : {}),
  });

  let res: Response;
  try {
    res = await openAiChatCompletionsJson(apiKey, {
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
  } catch (e: any) {
    await logEvent("warn", {
      type: "llm_error",
      requestId: opts?.requestId ?? null,
      provider: "openai",
      model,
      status: 0,
      body: String(e?.message ?? e),
    });
    throw e;
  }
  const json = (await res.json()) as any;
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("OpenAI response missing content.");
  await logEvent("info", {
    type: "llm_response",
    requestId: opts?.requestId ?? null,
    provider: "openai",
    model,
    ok: true,
    contentChars: text.length,
    contentPreview: textPreview(text, 600),
    ...(logFull ? { content: text } : {}),
  });
  const raw = JSON.parse(text);
  const normalized = normalizeRawAction(schema, transcript, raw);
  try {
    return ParsedActionZ.parse(normalized);
  } catch (e: any) {
    await logEvent("warn", {
      type: "llm_invalid_action",
      requestId: opts?.requestId ?? null,
      provider: "openai",
      model,
      issues: e?.issues ?? String(e?.message ?? e),
    });
    throw e;
  }
}

async function openAiChatCompletionsJson(
  apiKey: string,
  payload: Record<string, unknown> & { model: string },
) {
  const attempt = async (body: Record<string, unknown>) => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return res;
  };

  // Some models only support default temperature; try with whatever payload asks for, then retry without it.
  const first = await attempt(payload);
  if (first.ok) return first;

  const bodyText = await first.text();
  const isTempUnsupported =
    first.status === 400 &&
    bodyText.includes('"param": "temperature"') &&
    (bodyText.includes("unsupported_value") || bodyText.includes("does not support"));

  if (!isTempUnsupported) {
    // Re-create a Response-like error by throwing; caller already logs.
    throw new Error(`OpenAI error: ${first.status} ${bodyText}`);
  }

  const { temperature: _t, ...withoutTemp } = payload as any;
  const second = await attempt(withoutTemp);
  if (second.ok) return second;
  const secondText = await second.text();
  throw new Error(`OpenAI error: ${second.status} ${secondText}`);
}

async function openAiRefineUpdateDelete(
  schema: SchemaRegistry,
  transcript: string,
  draft: ParsedAction,
  opts?: { requestId?: string },
): Promise<ParsedAction> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

  if (!(draft.type === "update_item" || draft.type === "delete_item")) return draft;
  if (!draft.listId && !draft.target) return draft;

  const resolvedListId = resolveListId(schema, draft as any);
  const listDef = schema.lists[resolvedListId];
  if (!listDef) return { ...draft, listId: resolvedListId, valid: false, confidence: 0 };

  const items = await readListItems(schema, resolvedListId);
  const compactItems = items.map((it) => ({ id: it.id, text: it.text ?? "" }));
  const query = !isUuidLike(draft.itemId) ? draft.itemId : transcript;
  const candidateItems = pickCandidates(compactItems, query, 40);
  const logFull = shouldLogLlmText();

  await logEvent("info", {
    type: "llm_refine_request",
    requestId: opts?.requestId ?? null,
    provider: "openai",
    model,
    actionType: draft.type,
    listId: resolvedListId,
    candidates: candidateItems.length,
    transcriptPreview: textPreview(transcript, 200),
    ...(logFull ? { transcript } : {}),
  });

  const system = [
    "You refine a draft action into ONE strict JSON action object.",
    "Output MUST be valid JSON only (no markdown, no prose).",
    "Always include: type, valid, confidence.",
    "You MUST keep listId exactly as provided.",
    "For update_item/delete_item: itemId MUST be one of the provided candidate item ids.",
    "If there is not a clear match, set valid=false and confidence low.",
    "For update_item: patch must be a FLAT object of list fields (e.g. {\"text\":\"...\"}).",
    "Do not put listId/target inside patch or inside fields.",
  ].join("\n");

  const user = JSON.stringify({
    transcript,
    list: { id: resolvedListId, title: listDef.title, fields: listDef.fields },
    draftAction: draft,
    candidateItems,
  });

  let res: Response;
  try {
    res = await openAiChatCompletionsJson(apiKey, {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
  } catch (e: any) {
    await logEvent("warn", {
      type: "llm_refine_error",
      requestId: opts?.requestId ?? null,
      provider: "openai",
      model,
      status: 0,
      body: String(e?.message ?? e),
    });
    return { ...draft, listId: resolvedListId, valid: false, confidence: 0 };
  }

  const json = (await res.json()) as any;
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string") return { ...draft, listId: resolvedListId, valid: false, confidence: 0 };
  await logEvent("info", {
    type: "llm_refine_response",
    requestId: opts?.requestId ?? null,
    provider: "openai",
    model,
    ok: true,
    contentChars: text.length,
    contentPreview: textPreview(text, 600),
    ...(logFull ? { content: text } : {}),
  });

  try {
    const raw = JSON.parse(text);
    const normalized = normalizeRawAction(schema, transcript, raw);
    const parsed = ParsedActionZ.parse(normalized);

    // Enforce the list and require UUID id to exist in that list for valid=true.
    if (!(parsed.type === "update_item" || parsed.type === "delete_item")) return { ...draft, listId: resolvedListId, valid: false, confidence: 0 };
    const fixed = { ...parsed, listId: resolvedListId, target: undefined } as ParsedAction;
    const okId = isUuidLike((fixed as any).itemId) && itemExists(items, (fixed as any).itemId);
    if (!okId) return { ...fixed, valid: false, confidence: 0 };
    return fixed;
  } catch (e: any) {
    await logEvent("warn", {
      type: "llm_refine_invalid_action",
      requestId: opts?.requestId ?? null,
      provider: "openai",
      model,
      issues: e?.issues ?? String(e?.message ?? e),
    });
    return { ...draft, listId: resolvedListId, valid: false, confidence: 0 };
  }
}

async function ollamaParse(
  schema: SchemaRegistry,
  transcript: string,
  opts?: { requestId?: string },
): Promise<ParsedAction> {
  const baseUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "llama3.1";

  const lists = Object.entries(schema.lists).map(([id, def]) => ({
    id,
    title: def.title,
    aliases: def.aliases ?? [],
    fields: def.fields,
  }));

  const system = [
    "Return ONE JSON object only.",
    "Allowed types: append_item, update_item, delete_item, create_list, add_fields.",
    "Always include: type, valid, confidence.",
    "IMPORTANT: listId/target must be top-level fields on the action, not inside `fields`.",
    "IMPORTANT: itemId should be the item's UUID if known; otherwise use a text query and lower confidence.",
    "IMPORTANT: for update_item, patch must be a FLAT object of list fields; do not nest inside `fields`.",
    "IMPORTANT: do not put listId/target inside patch; put them top-level on the action.",
    "Allowed field types for add_fields: string, int, boolean, float, date, time, json.",
  ].join("\n");

  const prompt = JSON.stringify({ transcript, availableLists: lists });
  const logFull = shouldLogLlmText();

  await logEvent("info", {
    type: "llm_request",
    requestId: opts?.requestId ?? null,
    provider: "ollama",
    model,
    transcriptChars: transcript.length,
    baseUrl,
    transcriptPreview: textPreview(transcript, 200),
    ...(logFull ? { transcript } : {}),
  });

  const res = await fetch(`${baseUrl.replaceAll(/\\/+$/g, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    await logEvent("warn", {
      type: "llm_error",
      requestId: opts?.requestId ?? null,
      provider: "ollama",
      model,
      status: res.status,
      body,
    });
    throw new Error(`Ollama error: ${res.status} ${body}`);
  }
  const json = (await res.json()) as any;
  const text = json.message?.content;
  if (typeof text !== "string") throw new Error("Ollama response missing content.");
  await logEvent("info", {
    type: "llm_response",
    requestId: opts?.requestId ?? null,
    provider: "ollama",
    model,
    ok: true,
    contentChars: text.length,
    contentPreview: textPreview(text, 600),
    ...(logFull ? { content: text } : {}),
  });
  const raw = JSON.parse(text);
  const normalized = normalizeRawAction(schema, transcript, raw);
  try {
    return ParsedActionZ.parse(normalized);
  } catch (e: any) {
    await logEvent("warn", {
      type: "llm_invalid_action",
      requestId: opts?.requestId ?? null,
      provider: "ollama",
      model,
      issues: e?.issues ?? String(e?.message ?? e),
    });
    throw e;
  }
}

export async function parseTranscript(
  schema: SchemaRegistry,
  transcript: string,
  opts?: { requestId?: string },
): Promise<ParsedAction> {
  const provider = (process.env.PA_LLM_PROVIDER ?? "heuristic") as Provider;
  await logEvent("debug", { type: "parse_start", requestId: opts?.requestId ?? null, provider });
  let action: ParsedAction;
  switch (provider) {
    case "openai":
      action = await openAiParse(schema, transcript, opts);
      // Correct-by-construction: refine update/delete by selecting a real UUID from list items.
      if (action.type === "update_item" || action.type === "delete_item") {
        action = await openAiRefineUpdateDelete(schema, transcript, action, opts);
      }
      return action;
    case "ollama":
      action = await ollamaParse(schema, transcript, opts);
      return action;
    case "heuristic":
    default:
      return heuristicParse(schema, transcript);
  }
}

export function canonicalizeActionTargets(schema: SchemaRegistry, action: ParsedAction): ParsedAction {
  if (action.type === "create_list") {
    if (action.listId) action.listId = sanitizeListId(action.listId);
    return action;
  }

  if ("listId" in action || "target" in action) {
    const listId = resolveListId(schema, action as any);
    // @ts-expect-error - narrow assignment is safe for our action shapes
    return { ...action, listId, target: undefined };
  }

  return action;
}
