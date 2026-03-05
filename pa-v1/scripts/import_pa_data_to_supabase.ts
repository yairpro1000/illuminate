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
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
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

async function main() {
  const supabaseUrl = mustEnv("SUPABASE_URL");
  const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const repoRoot = path.resolve(__dirname, "..", "..");
  const dataDir = path.join(repoRoot, "pa-v1", "data");
  const schemaPath = path.join(dataDir, "meta", "lists.schema.json");
  const listsDir = path.join(dataDir, "lists");

  const schema = readJson(schemaPath) as SchemaFile;

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

    const mergedFields = { ...universalFields, ...def.fields };
    for (const [name, f] of Object.entries(mergedFields)) {
      const row = {
        list_id: listId,
        name,
        type: f.type,
        default_value_json: Object.prototype.hasOwnProperty.call(f, "default") ? (f as any).default : null,
        nullable: Boolean((f as any).nullable ?? false),
        description: (f as any).description ?? null,
        ui_show_in_preview: (f as any).ui?.showInPreview ?? null,
      };
      const { error } = await supabase.from("pa_list_fields").upsert(row, { onConflict: "list_id,name" });
      if (error) throw error;
    }

    const listJsonl = path.join(listsDir, `${listId}.jsonl`);
    const items = await iterJsonl(listJsonl);
    for (const it of items) {
      const row = {
        id: it.id,
        list_id: listId,
        created_at: isoOrNull(it.createdAt) ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
  }

  process.stdout.write("OK: imported schema + items into Supabase.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
