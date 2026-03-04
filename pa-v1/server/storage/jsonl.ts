import fs from "node:fs";
import fsp from "node:fs/promises";
import readline from "node:readline";

export async function readJsonl<T extends Record<string, unknown>>(filePath: string): Promise<T[]> {
  try {
    await fsp.access(filePath);
  } catch {
    return [];
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const items: T[] = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    items.push(JSON.parse(trimmed) as T);
  }

  return items;
}

export async function writeJsonl<T extends Record<string, unknown>>(
  filePath: string,
  items: T[],
): Promise<void> {
  const content = items.map((it) => JSON.stringify(it)).join("\n") + (items.length ? "\n" : "");
  await fsp.writeFile(filePath, content, "utf8");
}

export async function rewriteJsonlStreaming<T extends Record<string, unknown>>(
  inputPath: string,
  outputPath: string,
  transform: (item: T) => T | null,
) {
  const stream = fs.createReadStream(inputPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out = fs.createWriteStream(outputPath, { encoding: "utf8" });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const item = JSON.parse(trimmed) as T;
    const next = transform(item);
    if (next) out.write(JSON.stringify(next) + "\n");
  }

  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });
}

