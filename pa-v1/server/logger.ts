import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { metaRoot } from "./paths";

type LogLevel = "debug" | "info" | "warn" | "error";

function nowIso() {
  return new Date().toISOString();
}

function envBool(name: string, defaultValue = false) {
  const raw = (process.env[name] ?? "").toLowerCase().trim();
  if (!raw) return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function safeJson(value: unknown) {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      return v;
    },
    0,
  );
}

export function makeRequestId() {
  return crypto.randomBytes(8).toString("hex");
}

function truncate(s: string, max = 3000) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(truncated ${s.length - max} chars)`;
}

export function textPreview(input: string, maxChars = 200) {
  const s = String(input ?? "");
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `…(truncated ${s.length - maxChars} chars)`;
}

export function shouldLogLlmText() {
  return envBool("PA_LOG_LLM_TEXT", false) || envBool("PA_LOG_SENSITIVE", false);
}

function redact(obj: any) {
  if (!obj || typeof obj !== "object") return obj;
  const cloned = Array.isArray(obj) ? obj.slice() : { ...obj };
  for (const key of Object.keys(cloned)) {
    const lower = key.toLowerCase();
    if (lower.includes("api_key") || lower.includes("authorization") || lower.includes("password")) {
      cloned[key] = "[REDACTED]";
    } else if (typeof cloned[key] === "object") {
      cloned[key] = redact(cloned[key]);
    }
  }
  return cloned;
}

async function ensureLogDir() {
  const dir = path.join(metaRoot, "logs");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function appendLogLine(line: string) {
  const enabled = (process.env.PA_LOG_TO_FILE ?? "").toLowerCase();
  if (!(enabled === "1" || enabled === "true" || enabled === "yes")) return;
  const dir = await ensureLogDir();
  const filePath = path.join(dir, "server.jsonl");
  await fs.appendFile(filePath, line + "\n", "utf8");
}

export async function logEvent(level: LogLevel, event: Record<string, unknown>) {
  const minLevel = (process.env.PA_LOG_LEVEL ?? "info") as LogLevel;
  const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((rank[level] ?? 20) < (rank[minLevel] ?? 20)) return;

  const includeSensitive = envBool("PA_LOG_SENSITIVE", false);

  const base = {
    ts: nowIso(),
    level,
    ...event,
  };

  const finalEvent = includeSensitive ? base : (redact(base) as Record<string, unknown>);
  const line = safeJson(finalEvent);

  const consoleMaxRaw = (process.env.PA_LOG_CONSOLE_MAX ?? "").trim();
  const consoleMax = consoleMaxRaw ? Number(consoleMaxRaw) : 4000;
  const consoleLine =
    Number.isFinite(consoleMax) && consoleMax > 0 ? (line.length > consoleMax ? truncate(line, consoleMax) : line) : line;

  // Always print to console (so you see it while running dev).
  // eslint-disable-next-line no-console
  console.log(consoleLine);

  await appendLogLine(line);
}
