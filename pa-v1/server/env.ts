import fs from "node:fs";
import path from "node:path";

function parseDotenv(contents: string) {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFromFile(envFilePath = path.join(process.cwd(), ".env")) {
  try {
    if (!fs.existsSync(envFilePath)) return;
    const contents = fs.readFileSync(envFilePath, "utf8");
    const parsed = parseDotenv(contents);
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // Best-effort only.
  }
}

