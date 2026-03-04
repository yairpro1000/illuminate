import fs from "node:fs/promises";
import { SchemaRegistryZ, type SchemaRegistry } from "../../shared/model";
import { metaRoot, schemaPath } from "../paths";

const defaultSchema: SchemaRegistry = {
  version: 1,
  lists: {
    inbox: {
      title: "Inbox",
      description: "Default capture list",
      aliases: ["tasks", "todo", "notes"],
      fields: {
        text: { type: "string" },
        priority: { type: "int", default: 3 },
        color: { type: "string", default: null, nullable: true },
        order: { type: "int", default: 0 },
      },
      ui: { defaultSort: "priority,order,createdAt" },
    },
  },
};

export async function ensureSchemaFile() {
  await fs.mkdir(metaRoot, { recursive: true });
  try {
    await fs.access(schemaPath);
  } catch {
    await fs.writeFile(schemaPath, JSON.stringify(defaultSchema, null, 2) + "\n", "utf8");
  }
}

export async function loadSchemaRegistry(): Promise<SchemaRegistry> {
  await ensureSchemaFile();
  const raw = await fs.readFile(schemaPath, "utf8");
  const parsed = SchemaRegistryZ.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid schema registry at ${schemaPath}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function saveSchemaRegistry(schema: SchemaRegistry) {
  const parsed = SchemaRegistryZ.safeParse(schema);
  if (!parsed.success) {
    throw new Error(`Refusing to write invalid schema registry: ${parsed.error.message}`);
  }
  await fs.writeFile(schemaPath, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
}

export function sanitizeListId(listId: string) {
  const normalized = listId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(
      `Invalid listId "${listId}". Use 1-64 chars: letters/numbers, '_' or '-', starting with alnum.`,
    );
  }
  return normalized;
}

export function resolveListId(schema: SchemaRegistry, target: { listId?: string; target?: string }) {
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

