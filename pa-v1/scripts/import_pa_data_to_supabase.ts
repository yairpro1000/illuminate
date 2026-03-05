import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createClient } from "@supabase/supabase-js";

type SchemaFile = {
  version: number;
  lists: Record<
    string,
    {
      title: string;
      description?: string;
      aliases?: string[];
      fields: Record<
        string,
        {
          type: string;
          default?: unknown;
          nullable?: boolean;
          description?: string;
          ui?: { showInPreview?: boolean };
        }
      >;
      ui?: { defaultSort?: string };
    }
  >;
};

const universalFields: Record<
  string,
  {
    type: string;
    default?: unknown;
    nullable?: boolean;
    description?: string;
  }
> = {
  text: { type: "string" },
  priority: { type: "int", default: 3 },
  color: { type: "string", default: null, nullable: true },
  order: { type: "int", default: 0 },
  status: { type: "string", default: "todo" },
  archivedAt: { type: "date", default: null, nullable: true },
  unarchivedAt: { type: "date", default: null, nullable: true },
};

function mustEnv(name: string) {
  const v = process.env[name];
  if (v === undefined) throw new Error(`Missing env var ${name}`);
  if (v.trim() === "") throw new Error(`Env var ${name} is set but empty`);
  return v;
}

function loadDotEnv(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function iterJsonl(filePath: string): Promise<any[]> {
  if (!fs.existsSync(filePath)) return [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out: any[] = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed));
  }
  return out;
}

function pickExtraFields(item: Record<string, any>) {
  const core = new Set([
    "id",
    "createdAt",
    "updatedAt",
    "text",
    "priority",
    "color",
    "status",
    "order",
    "archivedAt",
    "unarchivedAt",
  ]);
  const extra: Record<string, any> = {};
  for (const [k, v] of Object.entries(item)) {
    if (core.has(k)) continue;
    extra[k] = v;
  }
  return extra;
}

function isoOrNull(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isUuidString(v: unknown): v is string {
  if (typeof v !== "string") return false;
  // Accept RFC 4122 variants (v1-v5) + any valid variant.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function main() {
  const projectRoot = path.resolve(__dirname, ".."); // .../pa-v1
  const repoRoot = path.resolve(__dirname, "..", ".."); // monorepo root

  // Source of truth: repo-root `.env` (gitignored).
  loadDotEnv(path.join(repoRoot, ".env"));

  const supabaseUrl = mustEnv("SUPABASE_URL");
  const secretKey = mustEnv("SUPABASE_SECRET_KEY");
  const supabase = createClient(supabaseUrl, secretKey, { auth: { persistSession: false } });

  const updatedBy = (process.env.PA_IMPORT_UPDATED_BY ?? process.env.PA_UPDATED_BY ?? "import").trim() || "import";

  const dataDir = path.join(projectRoot, "data");
  const schemaPath = path.join(dataDir, "meta", "lists.schema.json");
  const listsDir = path.join(dataDir, "lists");

  const schema = readJson(schemaPath) as SchemaFile;

  // Base fields are defined once (avoid duplicating on every list).
  const baseFieldNames = new Set(Object.keys(universalFields));
  for (const [name, f] of Object.entries(universalFields)) {
    const row = {
      name,
      type: f.type,
      default_value_json: Object.prototype.hasOwnProperty.call(f, "default") ? (f as any).default : null,
      nullable: Boolean((f as any).nullable ?? false),
      description: (f as any).description ?? null,
      ui_show_in_preview: null,
    };
    const { error } = await supabase.from("pa_base_fields").upsert(row, { onConflict: "name" });
    if (error) throw error;
  }

  for (const [listId, def] of Object.entries(schema.lists)) {
    const listRow = {
      list_id: listId,
      title: def.title,
      description: def.description ?? null,
      ui_default_sort: def.ui?.defaultSort ?? null,
    };
    const { error: listErr } = await supabase.from("pa_lists").upsert(listRow);
    if (listErr) throw listErr;

    for (const alias of def.aliases ?? []) {
      const { error } = await supabase
        .from("pa_list_aliases")
        .upsert({ list_id: listId, alias }, { onConflict: "list_id,alias" });
      if (error) throw error;
    }

    // Only store list-specific fields (base fields are in `pa_base_fields`).
    for (const [name, f] of Object.entries(def.fields)) {
      if (baseFieldNames.has(name)) continue;
      const row = {
        list_id: listId,
        name,
        type: f.type,
        default_value_json: Object.prototype.hasOwnProperty.call(f, "default") ? (f as any).default : null,
        nullable: Boolean((f as any).nullable ?? false),
        description: (f as any).description ?? null,
        ui_show_in_preview: (f as any).ui?.showInPreview ?? null,
      };
      const { error } = await supabase.from("pa_list_custom_fields").upsert(row, { onConflict: "list_id,name" });
      if (error) throw error;
    }

    const listJsonl = path.join(listsDir, `${listId}.jsonl`);
    const items = await iterJsonl(listJsonl);
    for (const it of items) {
      if (!isUuidString(it.id)) throw new Error(`Missing/invalid uuid for item id in list ${listId}: ${String(it.id)}`);
      const createdAtIso = isoOrNull(it.createdAt) ?? new Date().toISOString();
      const updatedAtIso = isoOrNull(it.updatedAt) ?? createdAtIso;
      const row = {
        id: it.id,
        list_id: listId,
        created_at: createdAtIso,
        updated_at: updatedAtIso,
        text: String(it.text ?? ""),
        priority: typeof it.priority === "number" ? it.priority : 3,
        color: typeof it.color === "string" ? it.color : null,
        status: typeof it.status === "string" ? it.status : "todo",
        order: typeof it.order === "number" ? it.order : 0,
        archived_at: isoOrNull(it.archivedAt),
        unarchived_at: isoOrNull(it.unarchivedAt),
        extra_fields: pickExtraFields(it),
      };
      const { error } = await supabase.from("pa_list_items").upsert(row);
      if (error) throw error;
    }

    // Complement optimistic concurrency: bump list revision after writing items.
    if (items.length > 0) {
      const { error } = await supabase.rpc("pa_touch_list", { p_list_id: listId, p_updated_by: updatedBy });
      if (error) throw error;
    }
  }

  process.stdout.write("OK: imported schema + items into Supabase.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
