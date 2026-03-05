import type { ParsedAction, SchemaRegistry } from "../../../pa-v1/shared/model";
import { ParsedActionZ } from "../../../pa-v1/shared/model";
import { isUuidLike, itemExists } from "../../../pa-v1/server/domain/itemId";

type Provider = "heuristic" | "openai";

function sanitizeListId(listId: string) {
  const normalized = listId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(
      `Invalid listId "${listId}". Use 1-64 chars: letters/numbers, '_' or '-', starting with alnum.`,
    );
  }
  return normalized;
}

function resolveListId(schema: SchemaRegistry, target: { listId?: string; target?: string }) {
  if (target.listId) return sanitizeListId(target.listId);
  const t = (target.target ?? "").trim().toLowerCase();
  const direct = Object.keys(schema.lists).find((id) => id.toLowerCase() === t);
  if (direct) return direct;
  for (const [id, def] of Object.entries(schema.lists)) {
    if (def.title.trim().toLowerCase() === t) return id;
    if ((def.aliases ?? []).some((a) => a.trim().toLowerCase() === t)) return id;
  }
  throw new Error(`Unknown list target "${target.target}".`);
}

function textPreview(text: string, max = 200) {
  const t = text.replaceAll(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

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

  const addFieldsMatch = lower.match(/^add fields? (?<fields>.+) to (list )?(?<list>.+)$/i);
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
    } as any;
  }

  const fallbackListId = schema.lists.app ? "app" : Object.keys(schema.lists)[0] ?? "inbox";
  return { type: "append_item", valid: true, confidence: 0.35, listId: fallbackListId, fields: { text: t } } as any;
}

function normalizeRawAction(schema: SchemaRegistry, transcript: string, raw: any) {
  const base = raw && typeof raw === "object" ? { ...raw } : {};

  if (base.type === "create_list") {
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
    if (base.fields === undefined && typeof base.text === "string") {
      base.fields = { text: base.text };
      delete base.text;
    }
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
    if (!base.listId && !base.target) base.listId = schema.lists.app ? "app" : Object.keys(schema.lists)[0] ?? "inbox";
    if (!base.fields || typeof base.fields !== "object") base.fields = { text: transcript };
    return base;
  }

  if (base.type === "update_item") {
    if (base.patch && typeof base.patch === "object") {
      const patchObj = base.patch as Record<string, unknown>;
      if (!base.listId && typeof patchObj.listId === "string" && patchObj.listId.trim() !== "") {
        base.listId = patchObj.listId;
        delete patchObj.listId;
      }
      if (!base.target && typeof patchObj.target === "string" && patchObj.target.trim() !== "") {
        base.target = patchObj.target;
        delete patchObj.target;
      }
      if ((patchObj as any).fields && typeof (patchObj as any).fields === "object") {
        const fields = (patchObj as any).fields as Record<string, unknown>;
        delete (patchObj as any).fields;
        base.patch = { ...patchObj, ...fields };
      } else {
        base.patch = patchObj;
      }
    }
    if (!base.listId && !base.target) {
      base.listId = schema.lists.app ? "app" : Object.keys(schema.lists)[0] ?? "inbox";
      base.valid = false;
      base.confidence = 0;
    }
    if (typeof base.itemId === "string" && !isUuidLike(base.itemId)) {
      base.valid = false;
      base.confidence = 0;
    }
    return base;
  }

  if (base.type === "delete_item") {
    if (!base.listId && !base.target) {
      base.listId = schema.lists.app ? "app" : Object.keys(schema.lists)[0] ?? "inbox";
      base.valid = false;
      base.confidence = 0;
    }
    if (typeof base.itemId === "string" && !isUuidLike(base.itemId)) {
      base.valid = false;
      base.confidence = 0;
    }
    return base;
  }

  if (base.type && !base.listId && !base.target) {
    base.listId = schema.lists.app ? "app" : Object.keys(schema.lists)[0] ?? "inbox";
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
  const best = scored
    .filter((s) => s.score > 0)
    .slice(0, max)
    .map((s) => s.it);
  if (best.length >= Math.min(8, max)) return best;
  return items.slice(-max);
}

async function openAiChatCompletionsJson(apiKey: string, payload: Record<string, unknown> & { model: string }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.ok) return res;
  const bodyText = await res.text();
  throw new Error(`OpenAI error: ${res.status} ${bodyText}`);
}

async function openAiParse(
  schema: SchemaRegistry,
  transcript: string,
  opts: { apiKey: string; model: string; requestId?: string },
): Promise<ParsedAction> {
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
    "Allowed types: append_item, update_item, delete_item, create_list, add_fields, move_item.",
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
  console.log(
    JSON.stringify({
      type: "llm_request",
      requestId: opts.requestId ?? null,
      provider: "openai",
      model: opts.model,
      transcriptChars: transcript.length,
      transcriptPreview: textPreview(transcript, 200),
    }),
  );

  const res = await openAiChatCompletionsJson(opts.apiKey, {
    model: opts.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const json = (await res.json()) as any;
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("OpenAI response missing content.");
  console.log(
    JSON.stringify({
      type: "llm_response",
      requestId: opts.requestId ?? null,
      provider: "openai",
      model: opts.model,
      ok: true,
      contentChars: text.length,
      contentPreview: textPreview(text, 600),
    }),
  );

  const raw = JSON.parse(text);
  const normalized = normalizeRawAction(schema, transcript, raw);
  return ParsedActionZ.parse(normalized);
}

async function openAiRefineUpdateDelete(
  schema: SchemaRegistry,
  transcript: string,
  draft: ParsedAction,
  candidates: Array<{ id: string; text: string }>,
  opts: { apiKey: string; model: string; requestId?: string },
): Promise<ParsedAction> {
  if (!(draft.type === "update_item" || draft.type === "delete_item")) return draft;
  if (!draft.listId && !draft.target) return draft;

  const resolvedListId = resolveListId(schema, draft as any);
  const listDef = schema.lists[resolvedListId];
  if (!listDef) return { ...draft, listId: resolvedListId, valid: false, confidence: 0 } as any;

  const query = !isUuidLike((draft as any).itemId) ? (draft as any).itemId : transcript;
  const candidateItems = pickCandidates(candidates, query, 40);

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

  const res = await openAiChatCompletionsJson(opts.apiKey, {
    model: opts.model,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const json = (await res.json()) as any;
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string") return { ...draft, listId: resolvedListId, valid: false, confidence: 0 } as any;

  try {
    const raw = JSON.parse(text);
    const normalized = normalizeRawAction(schema, transcript, raw);
    const parsed = ParsedActionZ.parse(normalized);
    if (!(parsed.type === "update_item" || parsed.type === "delete_item"))
      return { ...draft, listId: resolvedListId, valid: false, confidence: 0 } as any;
    const fixed = { ...parsed, listId: resolvedListId, target: undefined } as ParsedAction;
    const okId = isUuidLike((fixed as any).itemId) && itemExists(candidates as any, (fixed as any).itemId);
    if (!okId) return { ...fixed, valid: false, confidence: 0 } as any;
    return fixed;
  } catch {
    return { ...draft, listId: resolvedListId, valid: false, confidence: 0 } as any;
  }
}

export async function parseTranscript(
  schema: SchemaRegistry,
  transcript: string,
  opts: { provider: Provider; openaiApiKey?: string; openaiModel?: string; requestId?: string; candidates?: Array<{ id: string; text: string }> },
): Promise<ParsedAction> {
  console.log(JSON.stringify({ type: "parse_start", requestId: opts.requestId ?? null, provider: opts.provider }));
  switch (opts.provider) {
    case "openai": {
      const apiKey = opts.openaiApiKey;
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
      const model = opts.openaiModel ?? "gpt-4.1-mini";
      let action = await openAiParse(schema, transcript, { apiKey, model, requestId: opts.requestId });
      if ((action.type === "update_item" || action.type === "delete_item") && opts.candidates) {
        action = await openAiRefineUpdateDelete(schema, transcript, action, opts.candidates, { apiKey, model, requestId: opts.requestId });
      }
      return action;
    }
    case "heuristic":
    default:
      return heuristicParse(schema, transcript);
  }
}

export async function refineUpdateDelete(
  schema: SchemaRegistry,
  transcript: string,
  draft: ParsedAction,
  candidates: Array<{ id: string; text: string }>,
  opts: { openaiApiKey: string; openaiModel?: string; requestId?: string },
) {
  const model = opts.openaiModel ?? "gpt-4.1-mini";
  return await openAiRefineUpdateDelete(schema, transcript, draft, candidates, {
    apiKey: opts.openaiApiKey,
    model,
    requestId: opts.requestId,
  });
}

export function canonicalizeActionTargets(schema: SchemaRegistry, action: ParsedAction): ParsedAction {
  if (action.type === "create_list") {
    if ((action as any).listId) (action as any).listId = sanitizeListId((action as any).listId);
    return action;
  }

  if ("listId" in (action as any) || "target" in (action as any)) {
    const listId = resolveListId(schema, action as any);
    return { ...action, listId, target: undefined } as any;
  }

  return action;
}
