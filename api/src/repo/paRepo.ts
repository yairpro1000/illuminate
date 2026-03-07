import type { FieldDef, ListDef, ListItem, ParsedAction, SchemaRegistry } from "../shared/model";
import { SchemaRegistryZ } from "../shared/model";
import { applyDefaultsForCreate, migrateAddMissingFields, validatePatch } from "../domain/validate";
import type { Db } from "./supabase";

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

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
}

type PaListRow = {
  list_id: string;
  user_id?: string;
  title: string;
  description: string | null;
  ui_default_sort: string | null;
  items_revision?: any;
  items_updated_at?: string;
  items_updated_by?: string | null;
};

type PaListAliasRow = {
  list_id: string;
  user_id?: string;
  alias: string;
};

type PaBaseFieldRow = {
  name: string;
  type: string;
  default_value_json: any;
  nullable: boolean;
  description: string | null;
  ui_show_in_preview: boolean | null;
};

type PaListCustomFieldRow = PaBaseFieldRow & {
  list_id: string;
  user_id?: string;
};

type PaListItemRow = {
  id: string;
  list_id: string;
  user_id?: string;
  created_at: string;
  updated_at: string;
  text: string;
  priority: number;
  color: string | null;
  status: string;
  order: number;
  archived_at: string | null;
  unarchived_at: string | null;
  extra_fields: Record<string, unknown>;
};

function conflict(details?: Record<string, unknown>) {
  const err = new Error("conflict");
  (err as any).status = 409;
  if (details) (err as any).details = JSON.stringify(details);
  return err;
}

function httpError(status: number, message: string, details?: string) {
  const err = new Error(message);
  (err as any).status = status;
  if (typeof details === "string") (err as any).details = details;
  return err;
}

const coreToDbColumn: Record<string, keyof PaListItemRow> = {
  text: "text",
  priority: "priority",
  color: "color",
  status: "status",
  order: "order",
  archivedAt: "archived_at",
  unarchivedAt: "unarchived_at",
};

function toIsoOrNull(v: unknown): string | null {
  if (v === null) return null;
  if (v === undefined) return null;
  if (typeof v !== "string") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function fromDbRow(row: PaListItemRow): ListItem {
  const out: Record<string, unknown> = {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    text: row.text,
    priority: row.priority,
    color: row.color,
    status: row.status,
    order: row.order,
    archivedAt: row.archived_at,
    unarchivedAt: row.unarchived_at,
    ...(row.extra_fields ?? {}),
  };
  return out as ListItem;
}

const baseFieldNames = new Set([
  "text",
  "priority",
  "color",
  "order",
  "status",
  "archivedAt",
  "unarchivedAt",
]);

const fallbackBaseDefs: Record<string, FieldDef> = {
  text: { type: "string" },
  priority: { type: "int", default: 3 },
  color: { type: "string", default: null, nullable: true },
  order: { type: "int", default: 0 },
  status: { type: "string", default: "todo" },
  archivedAt: { type: "date", default: null, nullable: true },
  unarchivedAt: { type: "date", default: null, nullable: true },
};

function fieldRowToDef(f: {
  type: string;
  default_value_json: any;
  nullable: boolean;
  description: string | null;
  ui_show_in_preview: boolean | null;
}): FieldDef {
  return {
    type: f.type as any,
    ...(f.default_value_json !== null ? { default: f.default_value_json } : {}),
    ...(typeof f.nullable === "boolean" ? { nullable: f.nullable } : {}),
    ...(typeof f.description === "string" ? { description: f.description } : {}),
    ...(typeof f.ui_show_in_preview === "boolean" ? { ui: { showInPreview: f.ui_show_in_preview } } : {}),
  };
}

async function touchListForUser(db: Db, userId: string, listId: string, updatedBy: string) {
  const { data, error } = await db.rpc("pa_touch_list", {
    p_user_id: userId,
    p_list_id: listId,
    p_updated_by: updatedBy,
  });
  if (error) throw error;
  return typeof data === "number" ? data : Number(data);
}

function splitFields(input: Record<string, unknown>) {
  const core: Partial<PaListItemRow> = {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const col = coreToDbColumn[k];
    if (col) {
      if (col === "archived_at" || col === "unarchived_at") {
        (core as any)[col] = toIsoOrNull(v);
      } else {
        (core as any)[col] = v;
      }
    } else {
      extra[k] = v;
    }
  }
  return { core, extra };
}

async function getMaxOrderInBucket(db: Db, userId: string, listId: string, priority: number) {
  const { data, error } = await db
    .from("pa_list_items")
    .select("order")
    .eq("user_id", userId)
    .eq("list_id", listId)
    .eq("priority", priority)
    .order("order", { ascending: false })
    .limit(1);
  if (error) throw error;
  const max = (data?.[0] as any)?.order;
  return typeof max === "number" ? max : -1;
}

export type { ListItem };

export type PaRepo = {
  loadSchemaRegistry(): Promise<SchemaRegistry>;
  listListsForUi(): Promise<
    Array<{
      id: string;
      title: string;
      description: string;
      aliases: string[];
      fields: Record<string, FieldDef>;
      ui: any;
      meta: { revision: number; itemsUpdatedAt: string; itemsUpdatedBy: string | null };
    }>
  >;
  listLists(schema: SchemaRegistry): Promise<
    Array<{ id: string; title: string; description: string; aliases: string[]; fields: Record<string, FieldDef>; ui: any }>
  >;
  readListItems(schema: SchemaRegistry, listId: string): Promise<ListItem[]>;
  appendItem(schema: SchemaRegistry, target: { listId?: string; target?: string }, fields: Record<string, unknown>, opts: { updatedBy: string }): Promise<{ listId: string; item: ListItem }>;
  updateItem(schema: SchemaRegistry, target: { listId?: string; target?: string }, itemId: string, patch: Record<string, unknown>, opts: { expectedUpdatedAt?: string; updatedBy: string }): Promise<{ listId: string; item: ListItem }>;
  deleteItem(schema: SchemaRegistry, target: { listId?: string; target?: string }, itemId: string, opts: { expectedUpdatedAt?: string; updatedBy: string }): Promise<{ listId: string; deletedId: string; prev: ListItem }>;
  readItemsByIds(itemIds: string[]): Promise<Map<string, { listId: string; item: ListItem }>>;
  upsertItem(listId: string, item: ListItem, opts: { updatedBy: string }): Promise<void>;
  patchItemRaw(listId: string, itemId: string, fields: Record<string, unknown>, opts: { updatedBy: string }): Promise<void>;
  moveItem(schema: SchemaRegistry, fromListIdInput: string, toListIdInput: string, itemId: string, opts: { updatedBy: string }): Promise<{ fromListId: string; toListId: string; itemId: string; moved: boolean }>;
  reorderWithinPriorityBucket(schema: SchemaRegistry, listIdInput: string, priority: number, orderedIds: string[], opts: { expectedRevision: number; updatedBy: string }): Promise<{ listId: string; priority: number; orderedIds: string[]; revision: number }>;
  createList(schema: SchemaRegistry, action: Extract<ParsedAction, { type: "create_list" }>): Promise<{ listId: string; created: boolean }>;
  addFields(schema: SchemaRegistry, action: Extract<ParsedAction, { type: "add_fields" }>, opts: { updatedBy: string }): Promise<{ listId: string; added: string[]; migrated: number }>;
  removeFields(schema: SchemaRegistry, action: Extract<ParsedAction, { type: "remove_fields" }>, opts: { updatedBy: string }): Promise<{ listId: string; removed: string[]; migrated: number }>;
  deleteList(schema: SchemaRegistry, listId: string): Promise<{ listId: string; items: ListItem[] }>;
};

export function makePaRepo(db: Db, userId: string): PaRepo {
  return {
    async loadSchemaRegistry() {
      const [
        { data: lists, error: listErr },
        { data: aliases, error: aliasErr },
        { data: baseFields, error: baseErr },
        { data: customFields, error: customErr },
      ] = await Promise.all([
        db.from("pa_lists").select("list_id,title,description,ui_default_sort").eq("user_id", userId),
        db.from("pa_list_aliases").select("list_id,alias").eq("user_id", userId),
        db.from("pa_base_fields").select("name,type,default_value_json,nullable,description,ui_show_in_preview"),
        db
          .from("pa_list_custom_fields")
          .select("list_id,name,type,default_value_json,nullable,description,ui_show_in_preview")
          .eq("user_id", userId),
      ]);
      if (listErr) throw listErr;
      if (aliasErr) throw aliasErr;
      if (baseErr) throw baseErr;
      if (customErr) throw customErr;

      const registry: SchemaRegistry = { version: 1, lists: {} };

      const aliasByList = new Map<string, string[]>();
      for (const a of (aliases ?? []) as PaListAliasRow[]) {
        const prev = aliasByList.get(a.list_id) ?? [];
        prev.push(a.alias);
        aliasByList.set(a.list_id, prev);
      }

      const baseDefs: Record<string, FieldDef> = {};
      for (const f of (baseFields ?? []) as PaBaseFieldRow[]) baseDefs[f.name] = fieldRowToDef(f);
      if (Object.keys(baseDefs).length === 0) Object.assign(baseDefs, fallbackBaseDefs);

      const fieldsByList = new Map<string, PaListCustomFieldRow[]>();
      for (const f of (customFields ?? []) as PaListCustomFieldRow[]) {
        const prev = fieldsByList.get(f.list_id) ?? [];
        prev.push(f);
        fieldsByList.set(f.list_id, prev);
      }

      for (const l of (lists ?? []) as PaListRow[]) {
        const listId = l.list_id;
        const defs: Record<string, FieldDef> = { ...baseDefs };
        for (const f of fieldsByList.get(listId) ?? []) {
          // Be tolerant of older/bad imports that duplicated base fields into custom-fields table.
          if (baseDefs[f.name]) continue;
          defs[f.name] = fieldRowToDef(f);
        }
        registry.lists[listId] = {
          title: l.title,
          description: l.description ?? undefined,
          aliases: aliasByList.get(listId) ?? [],
          fields: defs,
          ui: l.ui_default_sort ? { defaultSort: l.ui_default_sort } : {},
        } as ListDef;
      }

      const parsed = SchemaRegistryZ.safeParse(registry);
      if (!parsed.success) throw new Error(`Invalid schema registry in DB: ${parsed.error.message}`);
      return parsed.data;
    },

    async listListsForUi() {
      const listSelectWithMeta =
        "list_id,title,description,ui_default_sort,items_revision,items_updated_at,items_updated_by";
      const listSelectFallback = "list_id,title,description,ui_default_sort";

      const listsResult = await db.from("pa_lists").select(listSelectWithMeta).eq("user_id", userId);
      const listErr: any = listsResult.error;
      const isMissingColumn =
        String(listErr?.code ?? "").trim() === "42703" ||
        /column .* does not exist/i.test(String(listErr?.message ?? "")) ||
        /schema cache/i.test(String(listErr?.message ?? ""));

      const listsFallbackResult =
        listErr && isMissingColumn ? await db.from("pa_lists").select(listSelectFallback).eq("user_id", userId) : null;

      const [
        { data: aliases, error: aliasErr },
        { data: baseFields, error: baseErr },
        { data: customFields, error: customErr },
      ] = await Promise.all([
        db.from("pa_list_aliases").select("list_id,alias").eq("user_id", userId),
        db.from("pa_base_fields").select("name,type,default_value_json,nullable,description,ui_show_in_preview"),
        db
          .from("pa_list_custom_fields")
          .select("list_id,name,type,default_value_json,nullable,description,ui_show_in_preview")
          .eq("user_id", userId),
      ]);
      const lists = (listsFallbackResult?.data ?? listsResult.data) as any;
      const listErrFinal = listsFallbackResult?.error ?? listsResult.error;
      if (listErrFinal) throw listErrFinal;
      if (aliasErr) throw aliasErr;
      if (baseErr) throw baseErr;
      if (customErr) throw customErr;

      const aliasByList = new Map<string, string[]>();
      for (const a of (aliases ?? []) as PaListAliasRow[]) {
        const prev = aliasByList.get(a.list_id) ?? [];
        prev.push(a.alias);
        aliasByList.set(a.list_id, prev);
      }

      const baseDefs: Record<string, FieldDef> = {};
      for (const f of (baseFields ?? []) as PaBaseFieldRow[]) baseDefs[f.name] = fieldRowToDef(f);
      if (Object.keys(baseDefs).length === 0) Object.assign(baseDefs, fallbackBaseDefs);

      const fieldsByList = new Map<string, PaListCustomFieldRow[]>();
      for (const f of (customFields ?? []) as PaListCustomFieldRow[]) {
        const prev = fieldsByList.get(f.list_id) ?? [];
        prev.push(f);
        fieldsByList.set(f.list_id, prev);
      }

      return ((lists ?? []) as PaListRow[]).map((l) => {
        const listId = l.list_id;
        const defs: Record<string, FieldDef> = { ...baseDefs };
        for (const f of fieldsByList.get(listId) ?? []) {
          if (baseDefs[f.name]) continue;
          defs[f.name] = fieldRowToDef(f);
        }

        const revisionRaw = (l as any).items_revision ?? 0;
        const revision = typeof revisionRaw === "number" ? revisionRaw : Number(revisionRaw);
        const itemsUpdatedAt = (l as any).items_updated_at ?? new Date(0).toISOString();
        const itemsUpdatedBy = (l as any).items_updated_by ?? null;

        return {
          id: listId,
          title: l.title,
          description: l.description ?? "",
          aliases: aliasByList.get(listId) ?? [],
          fields: defs,
          ui: l.ui_default_sort ? { defaultSort: l.ui_default_sort } : {},
          meta: { revision, itemsUpdatedAt, itemsUpdatedBy },
        };
      });
    },

    async listLists(schema) {
      return Object.entries(schema.lists).map(([id, def]) => ({
        id,
        title: def.title,
        description: def.description ?? "",
        aliases: def.aliases ?? [],
        fields: def.fields,
        ui: def.ui ?? {},
      }));
    },

    async readListItems(schema, listIdInput) {
      const listId = resolveListId(schema, { listId: listIdInput });
      const { data, error } = await db
        .from("pa_list_items")
        .select(
          "id,list_id,created_at,updated_at,text,priority,color,status,order,archived_at,unarchived_at,extra_fields",
        )
        .eq("user_id", userId)
        .eq("list_id", listId)
        .order("priority", { ascending: true })
        .order("order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as PaListItemRow[]).map(fromDbRow);
    },

    async appendItem(schema, target, fields, opts) {
      const listId = resolveListId(schema, target);
      const listDef = schema.lists[listId];
      if (!listDef) throw new Error(`List "${listId}" not found.`);

      const coerced = applyDefaultsForCreate(listDef, fields);
      if (typeof (coerced as any).text !== "string" || String((coerced as any).text).trim() === "") {
        throw new Error(`Field "text" is required.`);
      }

      const nowIso = new Date().toISOString();
      const id = crypto.randomUUID();
      const priority = typeof (coerced as any).priority === "number" ? ((coerced as any).priority as number) : 3;
      const maxOrder = await getMaxOrderInBucket(db, userId, listId, priority);
      const order = maxOrder + 1;

      const { core, extra } = splitFields(coerced as Record<string, unknown>);
      const row = {
        id,
        list_id: listId,
        user_id: userId,
        created_at: nowIso,
        updated_at: nowIso,
        text: String((core as any).text ?? ""),
        priority: typeof (core as any).priority === "number" ? (core as any).priority : 3,
        color: typeof (core as any).color === "string" ? (core as any).color : null,
        status: typeof (core as any).status === "string" ? (core as any).status : "todo",
        order,
        archived_at: (core as any).archived_at ?? null,
        unarchived_at: (core as any).unarchived_at ?? null,
        extra_fields: extra,
      };

      const { error } = await db.from("pa_list_items").insert(row);
      if (error) throw error;
      await touchListForUser(db, userId, listId, opts.updatedBy);

      const item = fromDbRow(row as any);
      return { listId, item };
    },

    async updateItem(schema, target, itemId, patch, opts) {
      const listId = resolveListId(schema, target);
      const listDef = schema.lists[listId];
      if (!listDef) throw new Error(`List "${listId}" not found.`);

      const validatedPatch = validatePatch(listDef, patch);

      const { data: prevRows, error: prevErr } = await db
        .from("pa_list_items")
        .select(
          "id,list_id,created_at,updated_at,text,priority,color,status,order,archived_at,unarchived_at,extra_fields",
        )
        .eq("user_id", userId)
        .eq("id", itemId)
        .eq("list_id", listId)
        .limit(1);
      if (prevErr) throw prevErr;
      const prev = (prevRows?.[0] as PaListItemRow | undefined) ?? null;
      if (!prev) throw new Error(`Item "${itemId}" not found.`);
      if (opts.expectedUpdatedAt && String(prev.updated_at) !== String(opts.expectedUpdatedAt)) {
        throw conflict({ expectedUpdatedAt: opts.expectedUpdatedAt, currentUpdatedAt: prev.updated_at });
      }

      const { core, extra } = splitFields(validatedPatch);
      const nextPriority =
        Object.prototype.hasOwnProperty.call(core, "priority") && typeof (core as any).priority === "number"
          ? ((core as any).priority as number)
          : prev.priority;

      const orderChanged = Object.prototype.hasOwnProperty.call(core, "order");
      const priorityChanged =
        Object.prototype.hasOwnProperty.call(core, "priority") && nextPriority !== prev.priority;

      let nextOrder = prev.order;
      if (priorityChanged && !orderChanged) {
        const maxOrder = await getMaxOrderInBucket(db, userId, listId, nextPriority);
        nextOrder = maxOrder + 1;
        (core as any).order = nextOrder;
      }

      const nowIso = new Date().toISOString();
      const nextExtra = { ...(prev.extra_fields ?? {}), ...extra };

      const updateRow: Record<string, unknown> = {
        updated_at: nowIso,
        extra_fields: nextExtra,
        ...(Object.keys(core).length ? core : {}),
      };

      const patchedFields = [...Object.keys(validatedPatch)];
      if (priorityChanged && !orderChanged) patchedFields.push("order");

      const { data: updatedRows, error: updErr } = await db
        .from("pa_list_items")
        .update(updateRow)
        .eq("user_id", userId)
        .eq("id", itemId)
        .eq("list_id", listId)
        .eq("updated_at", opts.expectedUpdatedAt ?? prev.updated_at)
        .select(
          "id,list_id,created_at,updated_at,text,priority,color,status,order,archived_at,unarchived_at,extra_fields",
        )
        .limit(1);
      if (updErr) throw updErr;
      const updated = updatedRows?.[0] as PaListItemRow | undefined;
      if (!updated) throw conflict({ expectedUpdatedAt: opts.expectedUpdatedAt ?? prev.updated_at });
      await touchListForUser(db, userId, listId, opts.updatedBy);
      return { listId, item: fromDbRow(updated), prev: fromDbRow(prev), patchedFields };
    },

    async deleteItem(schema, target, itemId, opts) {
      const listId = resolveListId(schema, target);
      const { data: prevRows, error: prevErr } = await db
        .from("pa_list_items")
        .select(
          "id,list_id,created_at,updated_at,text,priority,color,status,order,archived_at,unarchived_at,extra_fields",
        )
        .eq("user_id", userId)
        .eq("id", itemId)
        .eq("list_id", listId)
        .limit(1);
      if (prevErr) throw prevErr;
      const prev = (prevRows?.[0] as PaListItemRow | undefined) ?? null;
      if (!prev) throw new Error(`Item "${itemId}" not found.`);
      if (opts.expectedUpdatedAt && String(prev.updated_at) !== String(opts.expectedUpdatedAt)) {
        throw conflict({ expectedUpdatedAt: opts.expectedUpdatedAt, currentUpdatedAt: prev.updated_at });
      }

      const { data: deletedRows, error } = await db
        .from("pa_list_items")
        .delete()
        .eq("user_id", userId)
        .eq("id", itemId)
        .eq("list_id", listId)
        .eq("updated_at", opts.expectedUpdatedAt ?? prev.updated_at)
        .select("id")
        .limit(1);
      if (error) throw error;
      if (!deletedRows?.[0]) throw conflict({ expectedUpdatedAt: opts.expectedUpdatedAt ?? prev.updated_at });
      await touchListForUser(db, userId, listId, opts.updatedBy);
      return { listId, deletedId: itemId, prev: fromDbRow(prev) };
    },

    async readItemsByIds(itemIds) {
      if (itemIds.length === 0) return new Map();
      const { data, error } = await db
        .from("pa_list_items")
        .select(
          "id,list_id,created_at,updated_at,text,priority,color,status,order,archived_at,unarchived_at,extra_fields",
        )
        .eq("user_id", userId)
        .in("id", itemIds);
      if (error) throw error;
      const result = new Map<string, { listId: string; item: ListItem }>();
      for (const row of (data ?? []) as PaListItemRow[]) {
        result.set(row.id, { listId: row.list_id, item: fromDbRow(row) });
      }
      return result;
    },

    async upsertItem(listId, item, opts) {
      const { id, createdAt, updatedAt: _updatedAt, ...rest } = item as any;
      const { core, extra } = splitFields(rest);
      const row = {
        id,
        list_id: listId,
        user_id: userId,
        created_at: createdAt ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        text: String((core as any).text ?? ""),
        priority: typeof (core as any).priority === "number" ? (core as any).priority : 3,
        color: (core as any).color ?? null,
        status: typeof (core as any).status === "string" ? (core as any).status : "todo",
        order: typeof (core as any).order === "number" ? (core as any).order : 0,
        archived_at: (core as any).archived_at ?? null,
        unarchived_at: (core as any).unarchived_at ?? null,
        extra_fields: extra,
      };
      const { data: existing, error: exErr } = await db
        .from("pa_list_items")
        .select("id")
        .eq("user_id", userId)
        .eq("id", id)
        .limit(1);
      if (exErr) throw exErr;
      if (existing?.[0]) {
        const { error } = await db.from("pa_list_items").update(row).eq("user_id", userId).eq("id", id);
        if (error) throw error;
      } else {
        const { error } = await db.from("pa_list_items").insert(row);
        if (error) throw error;
      }
      await touchListForUser(db, userId, listId, opts.updatedBy);
    },

    async patchItemRaw(listId, itemId, fields, opts) {
      const { core, extra } = splitFields(fields);
      const updateRow: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const [k, v] of Object.entries(core as Record<string, unknown>)) {
        updateRow[k] = v;
      }
      if (Object.keys(extra).length > 0) {
        const { data: prevRows, error: prevErr } = await db
          .from("pa_list_items")
          .select("extra_fields")
          .eq("user_id", userId)
          .eq("id", itemId)
          .eq("list_id", listId)
          .limit(1);
        if (prevErr) throw prevErr;
        const currentExtra = (prevRows?.[0] as any)?.extra_fields ?? {};
        updateRow.extra_fields = { ...currentExtra, ...extra };
      }
      const { error } = await db
        .from("pa_list_items")
        .update(updateRow)
        .eq("user_id", userId)
        .eq("id", itemId)
        .eq("list_id", listId);
      if (error) throw error;
      await touchListForUser(db, userId, listId, opts.updatedBy);
    },

    async moveItem(schema, fromListIdInput, toListIdInput, itemId, opts) {
      const fromListId = resolveListId(schema, { listId: fromListIdInput });
      const toListId = resolveListId(schema, { listId: toListIdInput });
      if (fromListId === toListId) return { fromListId, toListId, itemId, moved: false };

      const { data: prevRows, error: prevErr } = await db
        .from("pa_list_items")
        .select(
          "id,list_id,created_at,updated_at,text,priority,color,status,order,archived_at,unarchived_at,extra_fields",
        )
        .eq("user_id", userId)
        .eq("id", itemId)
        .eq("list_id", fromListId)
        .limit(1);
      if (prevErr) throw prevErr;
      const prev = (prevRows?.[0] as PaListItemRow | undefined) ?? null;
      if (!prev) throw new Error(`Item "${itemId}" not found in "${fromListId}".`);

      const toDef = schema.lists[toListId];
      if (!toDef) throw new Error(`List "${toListId}" not found.`);

      const itemJson = fromDbRow(prev) as any;
      const picked: Record<string, unknown> = {};
      for (const key of Object.keys(toDef.fields)) {
        if (Object.prototype.hasOwnProperty.call(itemJson, key)) picked[key] = itemJson[key];
      }
      const coerced = applyDefaultsForCreate(toDef, picked);

      const priority = typeof (coerced as any).priority === "number" ? ((coerced as any).priority as number) : 3;
      const maxOrder = await getMaxOrderInBucket(db, userId, toListId, priority);
      const order = maxOrder + 1;

      const { core, extra } = splitFields(coerced as Record<string, unknown>);
      const nowIso = new Date().toISOString();
      const updateRow: Record<string, unknown> = {
        list_id: toListId,
        updated_at: nowIso,
        text: String((core as any).text ?? prev.text),
        priority: typeof (core as any).priority === "number" ? (core as any).priority : priority,
        color: typeof (core as any).color === "string" ? (core as any).color : null,
        status: typeof (core as any).status === "string" ? (core as any).status : "todo",
        order,
        archived_at: (core as any).archived_at ?? null,
        unarchived_at: (core as any).unarchived_at ?? null,
        extra_fields: extra,
      };

      const { error: updErr } = await db
        .from("pa_list_items")
        .update(updateRow)
        .eq("user_id", userId)
        .eq("id", itemId)
        .eq("list_id", fromListId);
      if (updErr) throw updErr;
      await Promise.all([
        touchListForUser(db, userId, fromListId, opts.updatedBy),
        touchListForUser(db, userId, toListId, opts.updatedBy),
      ]);

      return { fromListId, toListId, itemId, moved: true };
    },

    async reorderWithinPriorityBucket(schema, listIdInput, priority, orderedIds, opts) {
      const listId = resolveListId(schema, { listId: listIdInput });

      const { data: rows, error } = await db
        .from("pa_list_items")
        .select("id")
        .eq("user_id", userId)
        .eq("list_id", listId)
        .eq("priority", priority)
        .in("id", orderedIds);
      if (error) throw error;
      if ((rows ?? []).length !== orderedIds.length) {
        const set = new Set((rows ?? []).map((r: any) => r.id));
        const missing = orderedIds.filter((id) => !set.has(id));
        throw new Error(`Reorder contains unknown IDs: ${missing.join(", ")}`);
      }

      const { data: nextRevision, error: rpcErr } = await db.rpc("pa_reorder_bucket", {
        p_user_id: userId,
        p_list_id: listId,
        p_priority: priority,
        p_ordered_ids: orderedIds,
        p_expected_revision: opts.expectedRevision,
        p_updated_by: opts.updatedBy,
      });
      if (rpcErr) {
        const msg = String((rpcErr as any)?.message ?? "").trim();
        const msgLower = msg.toLowerCase();
        const details = String((rpcErr as any)?.details ?? "");
        const isNamed = (name: string) => msgLower === name || msgLower.endsWith(`: ${name}`) || msgLower.endsWith(` ${name}`);

        if (isNamed("conflict")) {
          let current: number | null = null;
          try {
            const parsed = JSON.parse(details);
            if (parsed && typeof parsed.current === "number") current = parsed.current;
            if (parsed && typeof parsed.current === "string") current = Number(parsed.current);
          } catch {
            // ignore
          }
          throw conflict({ currentRevision: current });
        }
        if (isNamed("bad_request")) {
          throw httpError(400, "bad_request", details || msg);
        }
        if (isNamed("not_found")) {
          throw httpError(404, "not_found", details || msg);
        }
        throw rpcErr;
      }

      const revision = typeof nextRevision === "number" ? nextRevision : Number(nextRevision);
      return { listId, priority, orderedIds, revision };
    },

    async createList(schema, action) {
      const listId = sanitizeListId(action.listId ?? slugify(action.title) ?? "new-list");
      if (schema.lists[listId]) throw new Error(`List "${listId}" already exists.`);

      const fields = action.fields ?? {};

      const { error: listErr } = await db
        .from("pa_lists")
        .insert({
          list_id: listId,
          user_id: userId,
          title: action.title,
          description: action.description ?? null,
          ui_default_sort: null,
        });
      if (listErr) {
        if ((listErr as any).code === "23505") throw httpError(409, "conflict", `A list with ID "${listId}" already exists.`);
        throw listErr;
      }

      for (const alias of action.aliases ?? []) {
        const { error } = await db
          .from("pa_list_aliases")
          .upsert({ list_id: listId, user_id: userId, alias }, { onConflict: "user_id,list_id,alias" });
        if (error) throw error;
      }

      for (const [name, def] of Object.entries(fields)) {
        if (baseFieldNames.has(name)) throw new Error(`Field "${name}" is a base field and cannot be customized per-list.`);
        if (["id", "createdAt", "updatedAt"].includes(name)) throw new Error(`Field "${name}" is reserved.`);
        const row = {
          list_id: listId,
          user_id: userId,
          name,
          type: def.type,
          default_value_json: Object.prototype.hasOwnProperty.call(def, "default") ? (def as any).default : null,
          // Custom fields should be optional by default (non-mandatory).
          nullable: typeof (def as any).nullable === "boolean" ? (def as any).nullable : true,
          description: (def as any).description ?? null,
          ui_show_in_preview: (def as any).ui?.showInPreview ?? null,
        };
        const { error } = await db.from("pa_list_custom_fields").upsert(row, { onConflict: "user_id,list_id,name" });
        if (error) throw error;
      }

      return { listId, created: true };
    },

    async addFields(schema, action, opts) {
      const listId = action.listId ? sanitizeListId(action.listId) : resolveListId(schema, action as any);
      const listDef = schema.lists[listId];
      if (!listDef) throw new Error(`List "${listId}" not found.`);

      const added: Array<{ name: string; def: FieldDef }> = [];
      for (const f of action.fieldsToAdd) {
        const name = f.name.trim();
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) {
          throw new Error(`Invalid field name "${name}". Use letters/numbers/_ starting with a letter.`);
        }
        if (baseFieldNames.has(name)) throw new Error(`Field "${name}" is a base field and cannot be added as custom.`);
        if (["id", "createdAt", "updatedAt"].includes(name)) throw new Error(`Field "${name}" is reserved.`);
        if (listDef.fields[name]) throw new Error(`Field "${name}" already exists on "${listId}".`);
        const def: FieldDef = {
          type: f.type,
          ...(Object.prototype.hasOwnProperty.call(f, "default") ? { default: f.default } : {}),
          // Custom fields are optional by default; only make them required if explicitly requested.
          ...(typeof f.nullable === "boolean" ? { nullable: f.nullable } : { nullable: true }),
          ...(typeof f.description === "string" ? { description: f.description } : {}),
        };
        listDef.fields[name] = def;
        added.push({ name, def });
      }

      for (const { name, def } of added) {
        const row = {
          list_id: listId,
          user_id: userId,
          name,
          type: def.type,
          default_value_json: Object.prototype.hasOwnProperty.call(def, "default") ? (def as any).default : null,
          // Custom fields should be optional by default (non-mandatory).
          nullable: typeof (def as any).nullable === "boolean" ? (def as any).nullable : true,
          description: (def as any).description ?? null,
          ui_show_in_preview: (def as any).ui?.showInPreview ?? null,
        };
        const { error } = await db.from("pa_list_custom_fields").upsert(row, { onConflict: "user_id,list_id,name" });
        if (error) throw error;
      }

      const { data: itemRows, error: itemsErr } = await db
        .from("pa_list_items")
        .select("id,extra_fields")
        .eq("user_id", userId)
        .eq("list_id", listId);
      if (itemsErr) throw itemsErr;

      let migrated = 0;
      for (const row of (itemRows ?? []) as Array<{ id: string; extra_fields: Record<string, unknown> }>) {
        const currentItem = { id: row.id, createdAt: new Date().toISOString(), ...(row.extra_fields ?? {}) } as any;
        const next = migrateAddMissingFields(listDef, currentItem, added);
        const nextExtra: Record<string, unknown> = {};
        for (const { name } of added) nextExtra[name] = (next as any)[name];
        const merged = { ...(row.extra_fields ?? {}), ...nextExtra };
        const { error } = await db
          .from("pa_list_items")
          .update({ extra_fields: merged, updated_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("id", row.id)
          .eq("list_id", listId);
        if (error) throw error;
        migrated += 1;
      }

      await touchListForUser(db, userId, listId, opts.updatedBy);
      return { listId, added: added.map((a) => a.name), migrated };
    },

    async deleteList(schema, listIdInput) {
      const listId = resolveListId(schema, { listId: listIdInput });
      const listDef = schema.lists[listId];
      if (!listDef) throw new Error(`List "${listId}" not found.`);

      // Read all items before deleting (for undo snapshots)
      const items = await this.readListItems(schema, listId);

      // Bulk delete all items
      const { error: itemsErr } = await db.from("pa_list_items").delete().eq("user_id", userId).eq("list_id", listId);
      if (itemsErr) throw itemsErr;

      // Delete custom fields
      const { error: cfErr } = await db.from("pa_list_custom_fields").delete().eq("user_id", userId).eq("list_id", listId);
      if (cfErr) throw cfErr;

      // Delete aliases
      const { error: aliasErr } = await db.from("pa_list_aliases").delete().eq("user_id", userId).eq("list_id", listId);
      if (aliasErr) throw aliasErr;

      // Delete the list itself
      const { error: listErr } = await db.from("pa_lists").delete().eq("user_id", userId).eq("list_id", listId);
      if (listErr) throw listErr;

      return { listId, items };
    },

    async removeFields(schema, action, opts) {
      const listId = action.listId ? sanitizeListId(action.listId) : resolveListId(schema, action as any);
      const listDef = schema.lists[listId];
      if (!listDef) throw new Error(`List "${listId}" not found.`);

      const toRemove = Array.from(
        new Set(
          (action.fieldsToRemove ?? [])
            .map((s) => String(s ?? "").trim())
            .filter(Boolean)
            .slice(0, 25),
        ),
      );
      if (toRemove.length === 0) throw new Error("No fields to remove.");

      const removed: string[] = [];
      for (const name of toRemove) {
        if (baseFieldNames.has(name)) throw new Error(`Field "${name}" is a base field and cannot be removed.`);
        if (["id", "createdAt", "updatedAt"].includes(name)) throw new Error(`Field "${name}" is reserved.`);
        if (!listDef.fields[name]) throw new Error(`Field "${name}" does not exist on "${listId}".`);
        delete listDef.fields[name];
        removed.push(name);
      }

      // Keep removal fast and reliable: deleting the custom-field definition hides the column in UI.
      // We intentionally do NOT scan/update every item row here (can time out on large lists).
      const { error } = await db
        .from("pa_list_custom_fields")
        .delete()
        .eq("user_id", userId)
        .eq("list_id", listId)
        .in("name", removed);
      if (error) throw error;

      await touchListForUser(db, userId, listId, opts.updatedBy);
      return { listId, removed, migrated: 0 };
    },
  };
}
