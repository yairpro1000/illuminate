import path from "node:path";

export const projectRoot = path.resolve(__dirname, "..");
export const dataRoot = path.join(projectRoot, "data");
export const metaRoot = path.join(dataRoot, "meta");
export const listsRoot = path.join(dataRoot, "lists");

export const schemaPath = path.join(metaRoot, "lists.schema.json");
export const authPath = path.join(metaRoot, "auth.json");

export function listJsonlPath(listId: string) {
  return path.join(listsRoot, `${listId}.jsonl`);
}

