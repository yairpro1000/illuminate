import type { FieldDef, ListDef, ListItem, ParsedAction, SchemaRegistry } from "../../../pa-v1/shared/model";
import { SchemaRegistryZ } from "../../../pa-v1/shared/model";
import { applyDefaultsForCreate, migrateAddMissingFields, validatePatch } from "../../../pa-v1/server/domain/validate";
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
  title: string;
  description: string | null;
  ui_default_sort: string | null;
};

type PaListAliasRow = {
  list_id: string;
  alias: string;
};

type PaListFieldRow = {
  list_id: string;
  name: string;
  type: string;
  default_value_json: any;
  nullable: boolean;
  description: string | null;
  ui_show_in_preview: boolean | null;
};

type PaListItemRow = {
  id: string;
  list_id: string;
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
    createdAt: new Date(row.created_at).toISOString(),
    text: row.text,
    priority: row.priority,
    color: row.color,
    status: row.status,
    order: row.order,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    unarchivedAt: row.unarchived_at ? new Date(row.unarchived_at).toISOString() : null,
    ...(row.extra_fields ?? {}),
  };
  return out as ListItem;
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

async function getMaxOrderInBucket(db: Db, listId: string, priority: number) {
  const { data, error } = await db
    .from("pa_list_items")
    .select("order")
    .eq("list_id", listId)
    .eq("priority", priority)
    .order("order", { ascending: false })
    .limit(1);
  if (error) throw error;
  const max = (data?.[0] as any)?.order;
  return typeof max === "number" ? max : -1;
}

export type PaRepo = {
  loadSchemaRegistry(): Promise<SchemaRegistry>;
  listLists(schema: SchemaRegistry): Promise<
    Array<{ id: string; title: string; description: string; aliases: string[]; fields: Record<string, FieldDef>; ui: any }>
  >;
  readListItems(schema: SchemaRegistry, listId: string): Promise<ListItem[]>;
  appendItem(schema: SchemaRegistry, target: { listId?: string; target?: string }, fields: Record<string, unknown>): Promise<{ listId: string; item: ListItem }>;
  updateItem(schema: SchemaRegistry, target: { listId?: string; target?: string }, itemId: string, patch: Record<string, unknown>): Promise<{ listId: string; item: ListItem }>;
  deleteItem(schema: SchemaRegistry, target: { listId?: string; target?: string }, itemId: string): Promise<{ listId: string; deletedId: string }>;
  moveItem(schema: SchemaRegistry, fromListIdInput: string, toListIdInput: string, itemId: string): Promise<{ fromListId: string; toListId: string; itemId: string; moved: boolean }>;
  reorderWithinPriorityBucket(schema: SchemaRegistry, listIdInput: string, priority: number, orderedIds: string[]): Promise<{ listId: string; priority: number; orderedIds: string[] }>;
  createList(schema: SchemaRegistry, action: Extract<ParsedAction, { type: "create_list" }>): Promise<{ listId: string; created: boolean }>;
  addFields(schema: SchemaRegistry, action: Extract<ParsedAction, { type: "add_fields" }>): Promise<{ listId: string; added: string[]; migrated: number }>;
};

export function makePaRepo(db: Db): PaRepo {
  return {
    async loadSchemaRegistry() {
      const [{ data: lists, error: listErr }, { data: aliases, error: aliasErr }, { data: fields, error: fieldErr }] =
        await Promise.all([
          db.from("pa_lists").select("list_id,title,description,ui_default_sort"),
          db.from("pa_list_aliases").select("list_id,alias"),
          db.from("pa_list_fields").select(
            "list_id,name,type,default_value_json,nullable,description,ui_show_in_preview",
          ),
        ]);
      if (listErr) throw listErr;
      if (aliasErr) throw aliasErr;
      if (fieldErr) throw fieldErr;

      const registry: SchemaRegistry = { version: 1, lists: {} };

      const aliasByList = new Map<string, string[]>();
      for (const a of (aliases ?? []) as PaListAliasRow[]) {
        const prev = aliasByList.get(a.list_id) ?? [];
        prev.push(a.alias);
        aliasByList.set(a.list_id, prev);
      }

      const fieldsByList = new Map<string, PaListFieldRow[]>();
      for (const f of (fields ?? []) as PaListFieldRow[]) {
        const prev = fieldsByList.get(f.list_id) ?? [];
        prev.push(f);
        fieldsByList.set(f.list_id, prev);
      }

      for (const l of (lists ?? []) as PaListRow[]) {
        const listId = l.list_id;
        const defs: Record<string, FieldDef> = {};
        for (const f of fieldsByList.get(listId) ?? []) {
          defs[f.name] = {
            type: f.type as any,
            ...(f.default_value_json !== null ? { default: f.default_value_json } : {}),
            ...(typeof f.nullable === "boolean" ? { nullable: f.nullable } : {}),
            ...(typeof f.description === "string" ? { description: f.description } : {}),
            ...(typeof f.ui_show_in_preview === "boolean"
              ? { ui: { showInPreview: f.ui_show_in_preview } }
              : {}),
          };
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
        .eq("list_id", listId)
        .order("priority", { ascending: true })
        .order("order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as PaListItemRow[]).map(fromDbRow);
    },

    async appendItem(schema, target, fields) {
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
      const maxOrder = await getMaxOrderInBucket(db, listId, priority);
      const order = maxOrder + 1;

      const { core, extra } = splitFields(coerced as Record<string, unknown>);
      const row = {
        id,
        list_id: listId,
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

      const item = fromDbRow(row as any);
      return { listId, item };
    },

    async updateItem(schema, target, itemId, patch) {
      const listId = resolveListId(schema, target);
      const listDef = schema.lists[listId];
      if (!listDef) throw new Error(`List "${listId}" not found.`);

      const validatedPatch = validatePatch(listDef, patch);

      const { data: prevRows, error: prevErr } = await db
        .from("pa_list_items")
        .select(
          "id,list_id,created_at,updated_at,text,priority,color,status,order,archived_at,unarchived_at,extra_fields",
        )
        .eq("id", itemId)
        .eq("list_id", listId)
        .limit(1);
      if (prevErr) throw prevErr;
      const prev = (prevRows?.[0] as PaListItemRow | undefined) ?? null;
      if (!prev) throw new Error(`Item "${itemId}" not found.`);

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
        const maxOrder = await getMaxOrderInBucket(db, listId, nextPriority);
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

      const { data: updatedRows, error: updErr } = await db
        .from("pa_list_items")
        .update(updateRow)
        .eq("id", itemId)
        .eq("list_id", listId)
        .select(
          "id,list_id,created_at,updated_at,text,priority,color,status,order,archived_at,unarchived_at,extra_fields",
        )
        .limit(1);
      if (updErr) throw updErr;
      const updated = updatedRows?.[0] as PaListItemRow | undefined;
      if (!updated) throw new Error(`Item "${itemId}" not found after update.`);
      return { listId, item: fromDbRow(updated) };
    },

    async deleteItem(schema, target, itemId) {
      const listId = resolveListId(schema, target);
      const { error } = await db.from("pa_list_items").delete().eq("id", itemId).eq("list_id", listId);
      if (error) throw error;
      return { listId, deletedId: itemId };
    },

    async moveItem(schema, fromListIdInput, toListIdInput, itemId) {
      const fromListId = resolveListId(schema, { listId: fromListIdInput });
      const toListId = resolveListId(schema, { listId: toListIdInput });
      if (fromListId === toListId) return { fromListId, toListId, itemId, moved: false };

      const { data: prevRows, error: prevErr } = await db
        .from("pa_list_items")
        .select(
          "id,list_id,created_at,updated_at,text,priority,color,status,order,archived_at,unarchived_at,extra_fields",
        )
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
      const maxOrder = await getMaxOrderInBucket(db, toListId, priority);
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

      const { error: updErr } = await db.from("pa_list_items").update(updateRow).eq("id", itemId);
      if (updErr) throw updErr;

      return { fromListId, toListId, itemId, moved: true };
    },

    async reorderWithinPriorityBucket(schema, listIdInput, priority, orderedIds) {
      const listId = resolveListId(schema, { listId: listIdInput });

      const { data: rows, error } = await db
        .from("pa_list_items")
        .select("id")
        .eq("list_id", listId)
        .eq("priority", priority)
        .in("id", orderedIds);
      if (error) throw error;
      if ((rows ?? []).length !== orderedIds.length) {
        const set = new Set((rows ?? []).map((r: any) => r.id));
        const missing = orderedIds.filter((id) => !set.has(id));
        throw new Error(`Reorder contains unknown IDs: ${missing.join(", ")}`);
      }

      const nowIso = new Date().toISOString();
      for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i]!;
        const { error: updErr } = await db
          .from("pa_list_items")
          .update({ order: i, updated_at: nowIso })
          .eq("id", id)
          .eq("list_id", listId)
          .eq("priority", priority);
        if (updErr) throw updErr;
      }

      return { listId, priority, orderedIds };
    },

    async createList(schema, action) {
      const listId = sanitizeListId(action.listId ?? slugify(action.title) ?? "new-list");
      if (schema.lists[listId]) throw new Error(`List "${listId}" already exists.`);

      const fields = action.fields ?? {
        text: { type: "string" },
        priority: { type: "int", default: 3 },
        color: { type: "string", default: null, nullable: true },
        order: { type: "int", default: 0 },
        status: { type: "string", default: "todo" },
        archivedAt: { type: "date", default: null, nullable: true },
        unarchivedAt: { type: "date", default: null, nullable: true },
      };

      const { error: listErr } = await db
        .from("pa_lists")
        .insert({
          list_id: listId,
          title: action.title,
          description: action.description ?? null,
          ui_default_sort: null,
        });
      if (listErr) throw listErr;

      for (const alias of action.aliases ?? []) {
        const { error } = await db
          .from("pa_list_aliases")
          .upsert({ list_id: listId, alias }, { onConflict: "list_id,alias" });
        if (error) throw error;
      }

      for (const [name, def] of Object.entries(fields)) {
        const row = {
          list_id: listId,
          name,
          type: def.type,
          default_value_json: Object.prototype.hasOwnProperty.call(def, "default") ? (def as any).default : null,
          nullable: Boolean((def as any).nullable ?? false),
          description: (def as any).description ?? null,
          ui_show_in_preview: (def as any).ui?.showInPreview ?? null,
        };
        const { error } = await db.from("pa_list_fields").upsert(row, { onConflict: "list_id,name" });
        if (error) throw error;
      }

      return { listId, created: true };
    },

    async addFields(schema, action) {
      const listId = action.listId ? sanitizeListId(action.listId) : resolveListId(schema, action as any);
      const listDef = schema.lists[listId];
      if (!listDef) throw new Error(`List "${listId}" not found.`);

      const added: Array<{ name: string; def: FieldDef }> = [];
      for (const f of action.fieldsToAdd) {
        const name = f.name.trim();
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) {
          throw new Error(`Invalid field name "${name}". Use letters/numbers/_ starting with a letter.`);
        }
        if (["id", "createdAt"].includes(name)) throw new Error(`Field "${name}" is reserved.`);
        if (listDef.fields[name]) throw new Error(`Field "${name}" already exists on "${listId}".`);
        const def: FieldDef = {
          type: f.type,
          ...(Object.prototype.hasOwnProperty.call(f, "default") ? { default: f.default } : {}),
          ...(typeof f.nullable === "boolean" ? { nullable: f.nullable } : {}),
          ...(typeof f.description === "string" ? { description: f.description } : {}),
        };
        listDef.fields[name] = def;
        added.push({ name, def });
      }

      for (const { name, def } of added) {
        const row = {
          list_id: listId,
          name,
          type: def.type,
          default_value_json: Object.prototype.hasOwnProperty.call(def, "default") ? (def as any).default : null,
          nullable: Boolean((def as any).nullable ?? false),
          description: (def as any).description ?? null,
          ui_show_in_preview: (def as any).ui?.showInPreview ?? null,
        };
        const { error } = await db.from("pa_list_fields").upsert(row, { onConflict: "list_id,name" });
        if (error) throw error;
      }

      const { data: itemRows, error: itemsErr } = await db
        .from("pa_list_items")
        .select("id,extra_fields")
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
          .eq("id", row.id)
          .eq("list_id", listId);
        if (error) throw error;
        migrated += 1;
      }

      return { listId, added: added.map((a) => a.name), migrated };
    },
  };
}
