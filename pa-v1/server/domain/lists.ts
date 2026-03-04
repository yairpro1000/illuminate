import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { FieldDef, ListItem, SchemaRegistry } from "../../shared/model";
import { listJsonlPath, listsRoot } from "../paths";
import { readJsonl, rewriteJsonlStreaming, writeJsonl } from "../storage/jsonl";
import { resolveListId, sanitizeListId } from "../storage/schema";
import { applyDefaultsForCreate, migrateAddMissingFields, validatePatch } from "./validate";

export async function ensureListsDir() {
  await fs.mkdir(listsRoot, { recursive: true });
}

function pickFieldsForTargetList(
  schema: SchemaRegistry,
  toListId: string,
  item: ListItem,
): Record<string, unknown> {
  const listDef = schema.lists[toListId];
  if (!listDef) throw new Error(`List "${toListId}" not found.`);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(listDef.fields)) {
    if (Object.prototype.hasOwnProperty.call(item, key)) out[key] = (item as any)[key];
  }
  return out;
}

export async function listLists(schema: SchemaRegistry) {
  return Object.entries(schema.lists).map(([id, def]) => ({
    id,
    title: def.title,
    description: def.description ?? "",
    aliases: def.aliases ?? [],
    fields: def.fields,
    ui: def.ui ?? {},
  }));
}

export async function readListItems(schema: SchemaRegistry, listId: string) {
  await ensureListsDir();
  const resolved = resolveListId(schema, { listId });
  const filePath = listJsonlPath(resolved);
  const items = await readJsonl<ListItem>(filePath);
  return items;
}

export async function appendItem(
  schema: SchemaRegistry,
  target: { listId?: string; target?: string },
  fields: Record<string, unknown>,
) {
  await ensureListsDir();
  const listId = resolveListId(schema, target);
  const listDef = schema.lists[listId];
  if (!listDef) throw new Error(`List "${listId}" not found.`);

  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();

  const coerced = applyDefaultsForCreate(listDef, fields);
  if (typeof coerced.text !== "string" || coerced.text.trim() === "") {
    throw new Error(`Field "text" is required.`);
  }

  const filePath = listJsonlPath(listId);
  const existing = await readJsonl<ListItem>(filePath);
  const priority = typeof coerced.priority === "number" ? (coerced.priority as number) : 3;
  const maxOrderInBucket = existing
    .filter((it) => (it.priority ?? 3) === priority)
    .reduce((m, it) => Math.max(m, typeof it.order === "number" ? it.order : 0), -1);
  const order = maxOrderInBucket + 1;

  const item: ListItem = {
    id,
    createdAt,
    ...(coerced as Record<string, unknown>),
    order,
  } as ListItem;

  await fs.appendFile(filePath, JSON.stringify(item) + "\n", "utf8");
  return { listId, item };
}

export async function updateItem(
  schema: SchemaRegistry,
  target: { listId?: string; target?: string },
  itemId: string,
  patch: Record<string, unknown>,
) {
  await ensureListsDir();
  const listId = resolveListId(schema, target);
  const listDef = schema.lists[listId];
  if (!listDef) throw new Error(`List "${listId}" not found.`);

  const validatedPatch = validatePatch(listDef, patch);

  const filePath = listJsonlPath(listId);
  const items = await readJsonl<ListItem>(filePath);
  const idx = items.findIndex((it) => it.id === itemId);
  if (idx < 0) throw new Error(`Item "${itemId}" not found.`);

  const prev = items[idx]!;
  let next = { ...prev, ...validatedPatch } as ListItem;

  const priorityChanged =
    Object.prototype.hasOwnProperty.call(validatedPatch, "priority") &&
    (prev.priority ?? 3) !== (next.priority ?? 3);
  const orderChanged = Object.prototype.hasOwnProperty.call(validatedPatch, "order");
  if (priorityChanged && !orderChanged) {
    const p = next.priority ?? 3;
    const maxOrderInBucket = items
      .filter((it) => it.id !== itemId && (it.priority ?? 3) === p)
      .reduce((m, it) => Math.max(m, typeof it.order === "number" ? it.order : 0), -1);
    next = { ...next, order: maxOrderInBucket + 1 };
  }

  items[idx] = next;
  await writeJsonl(filePath, items);
  return { listId, item: next };
}

export async function deleteItem(
  schema: SchemaRegistry,
  target: { listId?: string; target?: string },
  itemId: string,
) {
  await ensureListsDir();
  const listId = resolveListId(schema, target);
  const filePath = listJsonlPath(listId);
  const items = await readJsonl<ListItem>(filePath);
  const next = items.filter((it) => it.id !== itemId);
  if (next.length === items.length) throw new Error(`Item "${itemId}" not found.`);
  await writeJsonl(filePath, next);
  return { listId, deletedId: itemId };
}

export async function moveItem(schema: SchemaRegistry, fromListIdInput: string, toListIdInput: string, itemId: string) {
  await ensureListsDir();
  const fromListId = resolveListId(schema, { listId: fromListIdInput });
  const toListId = resolveListId(schema, { listId: toListIdInput });
  if (fromListId === toListId) return { fromListId, toListId, itemId, moved: false };

  const fromPath = listJsonlPath(fromListId);
  const toPath = listJsonlPath(toListId);

  const fromItems = await readJsonl<ListItem>(fromPath);
  const idx = fromItems.findIndex((it) => it.id === itemId);
  if (idx < 0) throw new Error(`Item "${itemId}" not found in "${fromListId}".`);

  const item = fromItems[idx]!;
  const fieldsForTarget = pickFieldsForTargetList(schema, toListId, item);
  const coerced = applyDefaultsForCreate(schema.lists[toListId]!, fieldsForTarget);

  const toItems = await readJsonl<ListItem>(toPath);
  const priority = typeof (coerced as any).priority === "number" ? ((coerced as any).priority as number) : 3;
  const maxOrderInBucket = toItems
    .filter((it) => (it.priority ?? 3) === priority)
    .reduce((m, it) => Math.max(m, typeof it.order === "number" ? it.order : 0), -1);
  const order = maxOrderInBucket + 1;

  const movedItem: ListItem = {
    id: item.id,
    createdAt: item.createdAt,
    ...(coerced as Record<string, unknown>),
    order,
  } as ListItem;

  await fs.appendFile(toPath, JSON.stringify(movedItem) + "\n", "utf8");

  const nextFrom = fromItems.filter((it) => it.id !== itemId);
  await writeJsonl(fromPath, nextFrom);

  return { fromListId, toListId, itemId, moved: true };
}

export async function reorderWithinPriorityBucket(
  schema: SchemaRegistry,
  listIdInput: string,
  priority: number,
  orderedIds: string[],
) {
  await ensureListsDir();
  const listId = resolveListId(schema, { listId: listIdInput });
  const filePath = listJsonlPath(listId);
  const items = await readJsonl<ListItem>(filePath);

  const set = new Set(orderedIds);
  const bucket = items.filter((it) => (it.priority ?? 3) === priority && set.has(it.id));
  if (bucket.length !== orderedIds.length) {
    const missing = orderedIds.filter((id) => !bucket.some((it) => it.id === id));
    throw new Error(`Reorder contains unknown IDs: ${missing.join(", ")}`);
  }

  const orderMap = new Map<string, number>();
  orderedIds.forEach((id, idx) => orderMap.set(id, idx));

  const next = items.map((it) => {
    if ((it.priority ?? 3) !== priority) return it;
    const o = orderMap.get(it.id);
    if (o === undefined) return it;
    return { ...it, order: o } as ListItem;
  });

  await writeJsonl(filePath, next);
  return { listId, priority, orderedIds };
}

export async function migrateListAddFields(
  schema: SchemaRegistry,
  target: { listId?: string; target?: string },
  fieldsToAdd: Array<{ name: string; def: FieldDef }>,
) {
  await ensureListsDir();
  const listId = resolveListId(schema, target);
  const filePath = listJsonlPath(listId);
  const tmpPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.tmp`);

  // If list file doesn't exist, nothing to migrate.
  try {
    await fs.access(filePath);
  } catch {
    return { listId, migrated: 0 };
  }

  let migrated = 0;
  await rewriteJsonlStreaming<ListItem>(filePath, tmpPath, (item) => {
    const next = migrateAddMissingFields(schema.lists[listId]!, item, fieldsToAdd);
    migrated += 1;
    return next;
  });
  await fs.rename(tmpPath, filePath);
  return { listId, migrated };
}

export async function createListFiles(listId: string) {
  await ensureListsDir();
  const id = sanitizeListId(listId);
  const filePath = listJsonlPath(id);
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, "", "utf8");
  }
  return { listId: id };
}
