import type { ParsedAction, SchemaRegistry } from "../shared/model";
import { ParsedActionZ } from "../shared/model";
import { isUuidLike, itemExists } from "../domain/itemId";

type Provider = "heuristic" | "openai";

export type ParseDebug = {
  requestId: string | null;
  providerRequested: Provider;
  method: "fast" | "heuristic" | "openai";
  rule?: string;
  model?: string;
};

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

function fallbackListId(schema: SchemaRegistry) {
  return schema.lists.app ? "app" : Object.keys(schema.lists)[0] ?? "inbox";
}

function splitLooseList(input: string, max = 25) {
  const cleaned = input
    .replaceAll(/[(){}\[\]]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  const parts = cleaned
    .split(/,|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
  return parts;
}

function splitFieldNames(input: string, max = 25) {
  const cleaned = input
    .replaceAll(/[(){}\[\]]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  const parts = cleaned
    .split(/,|\band\b|\s+/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
  return parts;
}

function listTargetMatchers(schema: SchemaRegistry) {
  const candidates: Array<{ raw: string; norm: string; listId: string }> = [];
  for (const [id, def] of Object.entries(schema.lists)) {
    candidates.push({ raw: id, norm: id.trim().toLowerCase(), listId: id });
    candidates.push({ raw: def.title, norm: def.title.trim().toLowerCase(), listId: id });
    for (const a of def.aliases ?? []) candidates.push({ raw: a, norm: a.trim().toLowerCase(), listId: id });
  }
  candidates.sort((a, b) => b.norm.length - a.norm.length);
  return candidates;
}

function extractLeadingListTarget(schema: SchemaRegistry, input: string): { listId: string; rest: string } | null {
  const raw = input.trimStart();
  const lower = raw.toLowerCase();
  const candidates = listTargetMatchers(schema);
  for (const c of candidates) {
    if (!c.norm) continue;
    if (!lower.startsWith(c.norm)) continue;
    const next = raw.slice(c.norm.length, c.norm.length + 1);
    if (next && !/[\s:.,;!?/\\-]/.test(next)) continue;
    const rest = raw.slice(c.norm.length).trimStart().replace(/^[:,-]\s*/, "");
    return { listId: c.listId, rest };
  }
  return null;
}

function patternParse(schema: SchemaRegistry, transcript: string): { action: ParsedAction; rule: string } | null {
  const t = transcript.trim();
  if (!t) return null;

  // "-list: item" means delete
  const colon = t.match(/^(?<minus>-)\s*(?<list>[^:]{1,80})\s*:\s*(?<items>.+)$/);
  if (colon?.groups?.list && colon.groups.items) {
    const listRaw = colon.groups.list.trim();
    const items = splitLooseList(colon.groups.items, 10);
    const itemId = (items[0] ?? colon.groups.items).trim();
    try {
      const listId = resolveListId(schema, { target: listRaw });
      return { rule: "minus_colon_delete", action: { type: "delete_item", valid: true, confidence: 0.9, listId, itemId } as any };
    } catch {
      return {
        rule: "minus_colon_delete",
        action: {
          type: "delete_item",
          valid: false,
          confidence: 0.1,
          listId: fallbackListId(schema),
          itemId,
        } as any,
      };
    }
  }

  // "list: a, b, c" means append (batch if multiple)
  const colonAdd = t.match(/^(?<list>[^:]{1,80})\s*:\s*(?<items>.+)$/);
  if (colonAdd?.groups?.list && colonAdd.groups.items && !t.startsWith("-")) {
    const listRaw = colonAdd.groups.list.trim();
    const items = splitLooseList(colonAdd.groups.items, 20);
    const texts = items.length ? items : [colonAdd.groups.items.trim()];
    try {
      const listId = resolveListId(schema, { target: listRaw });
      // Let the LLM handle translate-list additions so translate processing runs
      if (listId === "translate") return null;
      if (texts.length === 1) {
        return {
          rule: "colon_add",
          action: { type: "append_item", valid: true, confidence: 0.9, listId, fields: { text: texts[0] } } as any,
        };
      }
      return {
        rule: "colon_add",
        action: {
          type: "batch",
          valid: true,
          confidence: 0.9,
          label: `Added ${texts.length} items to ${schema.lists[listId]?.title ?? listId}`,
          actions: texts.map((text) => ({ type: "append_item", listId, fields: { text } })),
        } as any,
      };
    } catch {
      // If the left side doesn't resolve to a real list target, don't treat it as "<list>: <items>".
      // This avoids swallowing commands like "add fields to chores: room, tools".
      return null;
    }
  }

  // "add to <list> <text>" (guardrail: never delete/update)
  if (/^add\s+to\s+/i.test(t)) {
    const rest = t.replace(/^add\s+to\s+/i, "");
    const extracted = extractLeadingListTarget(schema, rest);
    if (extracted) {
      const text = extracted.rest.trim();
      if (!text) {
        return {
          rule: "add_to",
          action: { type: "append_item", valid: false, confidence: 0, listId: extracted.listId, fields: { text: "" } } as any,
        };
      }
      return {
        rule: "add_to",
        action: { type: "append_item", valid: true, confidence: 0.9, listId: extracted.listId, fields: { text } } as any,
      };
    }
    const m = rest.match(/^(?<list>\\S+)\\s+(?<text>.+)$/);
    if (m?.groups?.list && m.groups.text) {
      return {
        rule: "add_to",
        action: {
          type: "append_item",
          valid: false,
          confidence: 0.2,
          target: m.groups.list.trim(),
          fields: { text: m.groups.text.trim() },
        } as any,
      };
    }
  }

  // "add <a, b and c> to <list>"
  const addTo = t.match(/^add\s+(?<items>.+?)\s+to\s+(?<list>.+)$/i);
  if (addTo?.groups?.items && addTo.groups.list) {
    const listRaw = addTo.groups.list.trim();
    const texts = splitLooseList(addTo.groups.items, 20);
    const finalTexts = texts.length ? texts : [addTo.groups.items.trim()];
    try {
      const listId = resolveListId(schema, { target: listRaw });
      if (finalTexts.length === 1) {
        return {
          rule: "add_items_to",
          action: { type: "append_item", valid: true, confidence: 0.85, listId, fields: { text: finalTexts[0] } } as any,
        };
      }
      return {
        rule: "add_items_to",
        action: {
          type: "batch",
          valid: true,
          confidence: 0.85,
          label: `Added ${finalTexts.length} items to ${schema.lists[listId]?.title ?? listId}`,
          actions: finalTexts.map((text) => ({ type: "append_item", listId, fields: { text } })),
        } as any,
      };
    } catch {
      return {
        rule: "add_items_to",
        action: {
          type: "append_item",
          valid: false,
          confidence: 0.15,
          target: listRaw,
          fields: { text: addTo.groups.items.trim() },
        } as any,
      };
    }
  }

  // "remove customfield/field <a, b> from <list>" (MUST be before generic remove-from)
  const removeFields = t.match(
    /^(remove|delete)\s+(custom\s*field|customfield|field|fields|column|columns)\s+(?<fields>.+?)\s+from\s+(?<list>.+)$/i,
  );
  if (removeFields?.groups?.fields && removeFields.groups.list) {
    const listRaw = removeFields.groups.list.trim();
    const names = splitFieldNames(removeFields.groups.fields, 25);
    try {
      const listId = resolveListId(schema, { target: listRaw });
      return {
        rule: "remove_fields",
        action: { type: "remove_fields", valid: true, confidence: 0.85, listId, fieldsToRemove: names } as any,
      };
    } catch {
      return {
        rule: "remove_fields",
        action: { type: "remove_fields", valid: false, confidence: 0.2, target: listRaw, fieldsToRemove: names } as any,
      };
    }
  }

  // "remove <item> from <list>"
  const removeFrom = t.match(/^(remove|delete)\s+(?<item>.+?)\s+from\s+(?<list>.+)$/i);
  if (removeFrom?.groups?.item && removeFrom.groups.list) {
    const itemId = removeFrom.groups.item.trim();
    const itemLower = itemId.toLowerCase();
    if (itemLower.startsWith("field ") || itemLower.startsWith("fields ") || itemLower.startsWith("customfield ")) return null;
    const listRaw = removeFrom.groups.list.trim();
    try {
      const listId = resolveListId(schema, { target: listRaw });
      return {
        rule: "remove_from",
        action: { type: "delete_item", valid: true, confidence: 0.85, listId, itemId } as any,
      };
    } catch {
      return { rule: "remove_from", action: { type: "delete_item", valid: false, confidence: 0.15, target: listRaw, itemId } as any };
    }
  }

  // "edit <from> to <to> from <list>"
  const editFrom = t.match(/^edit\s+(?<from>.+?)\s+to\s+(?<to>.+?)\s+from\s+(?<list>.+)$/i);
  if (editFrom?.groups?.from && editFrom.groups.to && editFrom.groups.list) {
    const listRaw = editFrom.groups.list.trim();
    try {
      const listId = resolveListId(schema, { target: listRaw });
      return {
        rule: "edit_from_to",
        action: {
          type: "update_item",
          valid: true,
          confidence: 0.8,
          listId,
          itemId: editFrom.groups.from.trim(),
          patch: { text: editFrom.groups.to.trim() },
        } as any,
      };
    } catch {
      return {
        rule: "edit_from_to",
        action: {
          type: "update_item",
          valid: false,
          confidence: 0.15,
          target: listRaw,
          itemId: editFrom.groups.from.trim(),
          patch: { text: editFrom.groups.to.trim() },
        } as any,
      };
    }
  }

  // "remove list <name>" / "delete list <name>"
  const deleteList = t.match(/^(remove|delete)\s+(the\s+)?list\s+(?<list>.+)$/i);
  if (deleteList?.groups?.list) {
    const listRaw = deleteList.groups.list.trim();
    try {
      const listId = resolveListId(schema, { target: listRaw });
      return {
        rule: "delete_list",
        action: { type: "delete_list", valid: true, confidence: 0.9, listId } as any,
      };
    } catch {
      return {
        rule: "delete_list",
        action: { type: "delete_list", valid: false, confidence: 0.2, target: listRaw } as any,
      };
    }
  }

  // "create list <name> with fields a, b"
  const createList = t.match(/^create\s+list\s+(?<title>.+?)(\s+with\s+fields?\s+(?<fields>.+))?$/i);
  if (createList?.groups?.title) {
    const title = createList.groups.title.trim();
    const listId = slugify(title) || "new-list";
    const fieldNames = createList.groups.fields ? splitFieldNames(createList.groups.fields, 25) : [];
    const fields: Record<string, any> = {};
    for (const name of fieldNames) {
      const key = name.trim();
      if (!key) continue;
      fields[key] = { type: "string", nullable: true };
    }
    return {
      rule: "create_list_fields",
      action: {
        type: "create_list",
        valid: true,
        confidence: 0.8,
        title,
        listId,
        ...(Object.keys(fields).length ? { fields } : {}),
      } as any,
    };
  }

  // "add fields to (the) (list) <list>: a, b" (prefer resolver-based extraction)
  if (/^add\s+fields?\s+to\s+/i.test(t)) {
    let rest = t.replace(/^add\s+fields?\s+to\s+/i, "").trim();
    rest = rest.replace(/^(the\s+)?list\s+/i, "").trim();
    const extracted = extractLeadingListTarget(schema, rest);
    if (extracted) {
      const names = splitFieldNames(extracted.rest, 25);
      if (names.length > 0) {
        return {
          rule: "add_fields",
          action: {
            type: "add_fields",
            valid: true,
            confidence: 0.85,
            listId: extracted.listId,
            fieldsToAdd: names.map((name) => ({ name, type: "string", nullable: true })),
          } as any,
        };
      }
    }
  }

  // "add fields to <list> a b c"
  const addFieldsTo = t.match(/^add\s+fields?\s+to\s+(?<list>\\S+)\\s+(?<fields>.+)$/i);
  if (addFieldsTo?.groups?.list && addFieldsTo.groups.fields) {
    const listRaw = addFieldsTo.groups.list.trim();
    const names = splitFieldNames(addFieldsTo.groups.fields, 25);
    try {
      const listId = resolveListId(schema, { target: listRaw });
      return {
        rule: "add_fields_to",
        action: {
          type: "add_fields",
          valid: true,
          confidence: 0.75,
          listId,
          fieldsToAdd: names.map((name) => ({ name, type: "string", nullable: true })),
        } as any,
      };
    } catch {
      return {
        rule: "add_fields_to",
        action: {
          type: "add_fields",
          valid: false,
          confidence: 0.15,
          target: listRaw,
          fieldsToAdd: names.map((name) => ({ name, type: "string", nullable: true })),
        } as any,
      };
    }
  }

  // "add fields <a, b> to <list>" (existing phrasing)
  const addFields = t.match(/^add\s+fields?\s+(?<fields>.+?)\s+to\s+(list\s+)?(?<list>.+)$/i);
  if (addFields?.groups?.fields && addFields.groups.list) {
    const listRaw = addFields.groups.list.trim();
    const names = splitFieldNames(addFields.groups.fields, 25);
    try {
      const listId = resolveListId(schema, { target: listRaw });
      return {
        rule: "add_fields",
        action: {
          type: "add_fields",
          valid: true,
          confidence: 0.75,
          listId,
          fieldsToAdd: names.map((name) => ({ name, type: "string", nullable: true })),
        } as any,
      };
    } catch {
      return {
        rule: "add_fields",
        action: {
          type: "add_fields",
          valid: false,
          confidence: 0.15,
          target: listRaw,
          fieldsToAdd: names.map((name) => ({ name, type: "string", nullable: true })),
        } as any,
      };
    }
  }

  return null;
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

  return { type: "append_item", valid: true, confidence: 0.35, listId: fallbackListId(schema), fields: { text: t } } as any;
}

function normalizeRawAction(schema: SchemaRegistry, transcript: string, raw: any) {
  const base = raw && typeof raw === "object" ? { ...raw } : {};

  if (base.type === "translate_intent") {
    if (typeof base.input !== "string" || !base.input.trim()) base.input = transcript.trim();
    if (typeof base.valid !== "boolean") base.valid = true;
    if (typeof base.confidence !== "number" || !Number.isFinite(base.confidence)) base.confidence = 0.9;
    return base;
  }

  if (base.type === "batch") {
    if (typeof base.valid !== "boolean") base.valid = true;
    if (typeof base.confidence !== "number" || !Number.isFinite(base.confidence)) base.confidence = 0.65;
    if (typeof base.label !== "string" || base.label.trim() === "") base.label = "Batch";
    if (!Array.isArray(base.actions)) {
      base.actions = [];
      base.valid = false;
      base.confidence = 0;
      return base;
    }
    base.actions = base.actions
      .filter((a: any) => a && typeof a === "object")
      .map((a: any) => {
        const out = { ...a };
        if (out.type === "append_item") {
          if (out.fields === undefined && out.item !== undefined) {
            out.fields = out.item;
            delete out.item;
          }
          if (!out.fields || typeof out.fields !== "object") out.fields = { text: "" };
        }
        return out;
      })
      .slice(0, 25);
    if (base.actions.length === 0) {
      base.valid = false;
      base.confidence = 0;
    }
    return base;
  }

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

  if (base.type === "delete_list") {
    if (!base.listId && !base.target) {
      base.valid = false;
      base.confidence = 0;
    }
    return base;
  }

  if (base.type && base.type !== "move_item" && base.type !== "batch" && !base.listId && !base.target) {
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

async function openAiChatCompletionsJsonBestEffort(apiKey: string, payload: Record<string, unknown> & { model: string }) {
  try {
    return await openAiChatCompletionsJson(apiKey, payload);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const seemsLikeResponseFormatIssue =
      /response_format/i.test(msg) ||
      /json_schema/i.test(msg) ||
      /Unknown parameter/i.test(msg) ||
      /Unrecognized request argument/i.test(msg);
    if (!seemsLikeResponseFormatIssue) throw e;

    const cloned = { ...payload } as any;
    delete cloned.response_format;
    return await openAiChatCompletionsJson(apiKey, cloned);
  }
}

function invalidParseFallback(schema: SchemaRegistry, transcript: string, confidence = 0) {
  return {
    type: "append_item",
    valid: false,
    confidence,
    listId: fallbackListId(schema),
    fields: { text: transcript.trim() },
  } as any as ParsedAction;
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
    "You are a strict parser that converts ONE user transcript into ONE strict JSON action object.",
    "Return ONLY valid JSON (no markdown, no prose, no code fences).",
    "The JSON must be a single object. Do not wrap in an array.",
    "Do not include unknown keys. All objects are strict.",
    "",
    "Always include: type, valid, confidence (0..1).",
    "If unsure or missing required info, set valid=false and confidence<=0.2.",
    "",
    "Allowed types:",
    "- append_item: {type,valid,confidence,listId|target,fields:{text,...}}",
    "- update_item: {type,valid,confidence,listId|target,itemId,patch:{...}}",
    "- delete_item: {type,valid,confidence,listId|target,itemId}",
    "- move_item: {type,valid,confidence,fromListId,toListId,itemId}",
    "- create_list: {type,valid,confidence,title,listId?,aliases?,fields?}",
    "- delete_list: {type,valid,confidence,listId|target}",
    "- add_fields: {type,valid,confidence,listId|target,fieldsToAdd:[{name,type,default?,nullable?,description?}]}",
    "- remove_fields: {type,valid,confidence,listId|target,fieldsToRemove:[\"fieldA\",...]}",
    "- batch: {type,valid,confidence,label,actions:[BatchActionItem,...]}",
    "- translate_intent: {type,valid,confidence,input} — ONLY for translation/lookup requests",
    "",
    "Translation detection (highest priority rule — check BEFORE anything else):",
    "If the transcript is asking to translate or look up a word/phrase in another language, return translate_intent.",
    "Examples that MUST produce translate_intent:",
    "  'how do you say chicken in italian'",
    "  'translate aggiungere'",
    "  'translate idempotency to hebrew'",
    "  'come si dice il latte in francese'",
    "  'come se dice mantequilla'",
    "  'como se dice butter in english'",
    "  'comment dit-on bonjour en espagnol'",
    "  'wie sagt man Schmetterling auf Englisch'",
    "  'how to say goodbye in german'",
    "For translate_intent set input to the original transcript verbatim.",
    "Do NOT return append_item or any other type for translation requests, even if a 'translate' list exists.",
    "",
    "BatchActionItem allowed types:",
    "- append_item: {type:\"append_item\",listId,fields:{text,...}}",
    "- update_item: {type:\"update_item\",listId,itemId,patch:{...}}",
    "- delete_item: {type:\"delete_item\",listId,itemId}",
    "",
    "List targeting:",
    "- Prefer listId as one of availableLists[].id.",
    "- If user uses a title/alias, you may use target instead of listId.",
    "",
    "Field rules:",
    "- append_item: fields must be an object and must include text (string).",
    "- update_item: patch must be a FLAT object (e.g. {\"text\":\"...\"}). Do NOT nest under patch.fields.",
    "- NEVER put listId/target inside fields or inside patch. They must be top-level only.",
    "",
    "Disambiguation guardrails (highest priority):",
    "1) If transcript starts with '-' then it is a delete intent (delete_item).",
    "2) If transcript matches '<list>: <items>' AND the part before ':' is exactly a list name (id/title/alias), then it is an add intent unless it starts with '-'.",
    "3) If transcript contains the phrase 'add to' then it is ALWAYS an add intent (append_item), never delete/update.",
    "",
    "Text extraction:",
    "- For 'add to <list> <text>', fields.text must be ONLY <text>. Do NOT include 'add to <list>' in the text.",
    "",
    "Multi-item adds:",
    "- If user provides multiple items (comma-separated or 'and'), return type='batch' with multiple append_item actions.",
    "",
    "Common patterns to support:",
    "- \"groceries: banana, eggs, gravy\" => batch append_item to groceries (3 items).",
    "- \"-groceries: banana\" => delete_item from groceries, itemId=\"banana\" (text query ok).",
    "- \"add banana, eggs and gravy to groceries\" => batch append_item.",
    "- \"add to app remove unnecessary columns\" => append_item to app, fields.text=\"remove unnecessary columns\".",
    "- \"remove list home\" => delete_list with listId=\"home\" (or target=\"home\" if not resolved).",
    "- \"delete list groceries\" => delete_list with listId=\"groceries\".",
    "- \"create list chores with fields room, tools\" => create_list with fields {room:{type:\"string\",nullable:true},tools:{...}}.",
    "- \"add fields to chores room tools\" => add_fields with fieldsToAdd room/tools.",
    "- \"remove customfield room from chores\" => remove_fields with fieldsToRemove [\"room\"].",
    "- \"edit banana to bananas from groceries\" => update_item with itemId=\"banana\" and patch {\"text\":\"bananas\"}.",
    "",
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

  const res = await openAiChatCompletionsJsonBestEffort(opts.apiKey, {
    model: opts.model,
    temperature: 0,
    response_format: { type: "json_object" },
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

  try {
    const raw = JSON.parse(text);
    const normalized = normalizeRawAction(schema, transcript, raw);
    return ParsedActionZ.parse(normalized);
  } catch {
    return invalidParseFallback(schema, transcript, 0);
  }
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

  const res = await openAiChatCompletionsJsonBestEffort(opts.apiKey, {
    model: opts.model,
    temperature: 0,
    response_format: { type: "json_object" },
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
  const fast = patternParse(schema, transcript);
  if (fast) return fast.action;
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

export async function parseTranscriptWithDebug(
  schema: SchemaRegistry,
  transcript: string,
  opts: { provider: Provider; openaiApiKey?: string; openaiModel?: string; requestId?: string; candidates?: Array<{ id: string; text: string }> },
): Promise<{ action: ParsedAction; debug: ParseDebug }> {
  const requestId = opts.requestId ?? null;
  const skipFast = Boolean((opts as any)?.skipFast);
  if (!skipFast) {
    const fast = patternParse(schema, transcript);
    if (fast) {
      return {
        action: fast.action,
        debug: { requestId, providerRequested: opts.provider, method: "fast", rule: fast.rule },
      };
    }
  }

  if (opts.provider === "openai") {
    const apiKey = opts.openaiApiKey;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
    const model = opts.openaiModel ?? "gpt-4.1-mini";
    let action = await openAiParse(schema, transcript, { apiKey, model, requestId: opts.requestId });
    if ((action.type === "update_item" || action.type === "delete_item") && opts.candidates) {
      action = await openAiRefineUpdateDelete(schema, transcript, action, opts.candidates, { apiKey, model, requestId: opts.requestId });
    }
    return { action, debug: { requestId, providerRequested: opts.provider, method: "openai", model } };
  }

  const action = heuristicParse(schema, transcript);
  return { action, debug: { requestId, providerRequested: opts.provider, method: "heuristic" } };
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

  if (action.type === "translate_intent") return action;

  if ("listId" in (action as any) || "target" in (action as any)) {
    const listId = resolveListId(schema, action as any);
    return { ...action, listId, target: undefined } as any;
  }

  return action;
}
