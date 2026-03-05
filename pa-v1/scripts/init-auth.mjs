import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

const username = getArg("--user");
const password = getArg("--pass");

if (!username || !password) {
  console.error("Usage: node scripts/init-auth.mjs --user <username> --pass <password>");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, "..", ".env");

const passwordHash = await bcrypt.hash(password, 10);
const sessionSecret = crypto.randomBytes(24).toString("hex");

function upsertEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  const suffix = text.endsWith("\n") || text.length === 0 ? "" : "\n";
  return text + suffix + line + "\n";
}

let existing = "";
try {
  existing = await fs.readFile(envPath, "utf8");
} catch {
  existing = "";
}

let next = existing;
next = upsertEnv(next, "PA_ADMIN_USER", username);
next = upsertEnv(next, "PA_ADMIN_PASS_HASH", passwordHash);
next = upsertEnv(next, "PA_SESSION_SECRET", sessionSecret);

await fs.writeFile(envPath, next, "utf8");
console.log(`Wrote ${envPath}`);
