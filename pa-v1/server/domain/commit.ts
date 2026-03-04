import type { FieldDef, ParsedAction, SchemaRegistry } from "../../shared/model";
import { sanitizeListId } from "../storage/schema";
import { saveSchemaRegistry } from "../storage/schema";
import { appendItem, createListFiles, deleteItem, migrateListAddFields, moveItem, updateItem } from "./lists";
import { isItemIdLike } from "./itemId";

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
}

const defaultListFields: Record<string, FieldDef> = {
  text: { type: "string" },
  priority: { type: "int", default: 3 },
  color: { type: "string", default: null, nullable: true },
  order: { type: "int", default: 0 },
};

export async function commitAction(schema: SchemaRegistry, action: ParsedAction) {
  if (!action.valid) throw new Error("Action is not valid; refusing to commit.");

  switch (action.type) {
    case "append_item":
      return await appendItem(schema, action, action.fields);
    case "update_item":
      if (!isItemIdLike(action.itemId)) throw new Error('update_item requires itemId to be a non-empty id.');
      return await updateItem(schema, action, action.itemId, action.patch);
    case "delete_item":
      if (!isItemIdLike(action.itemId)) throw new Error('delete_item requires itemId to be a non-empty id.');
      return await deleteItem(schema, action, action.itemId);
    case "move_item":
      if (!isItemIdLike(action.itemId)) throw new Error('move_item requires itemId to be a non-empty id.');
      return await moveItem(schema, action.fromListId, action.toListId, action.itemId);
    case "create_list": {
      const listId = sanitizeListId(action.listId ?? slugify(action.title) ?? "new-list");
      if (schema.lists[listId]) throw new Error(`List "${listId}" already exists.`);
      const fields = action.fields ?? defaultListFields;
      if (!fields.text) throw new Error(`New list must include a "text" field.`);
      schema.lists[listId] = {
        title: action.title,
        description: action.description,
        aliases: action.aliases,
        fields,
      };
      await saveSchemaRegistry(schema);
      await createListFiles(listId);
      return { listId, created: true };
    }
    case "add_fields": {
      const listId = action.listId ? sanitizeListId(action.listId) : undefined;
      if (!listId) throw new Error("listId is required for add_fields after resolution.");
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

      await saveSchemaRegistry(schema);
      const mig = await migrateListAddFields(schema, { listId }, added);
      return { listId, added: added.map((a) => a.name), migrated: mig.migrated };
    }
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
