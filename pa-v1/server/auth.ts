import fs from "node:fs/promises";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { authPath, metaRoot } from "./paths";

const AuthFileZ = z
  .object({
    username: z.string().min(1),
    passwordHash: z.string().min(1),
  })
  .strict();
type AuthFile = z.infer<typeof AuthFileZ>;

export async function loadAuthFile(): Promise<AuthFile> {
  await fs.mkdir(metaRoot, { recursive: true });
  const raw = await fs.readFile(authPath, "utf8");
  const parsed = AuthFileZ.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`Invalid auth file at ${authPath}: ${parsed.error.message}`);
  return parsed.data;
}

export async function verifyLogin(username: string, password: string) {
  const envUser = process.env.PA_ADMIN_USER;
  const envPass = process.env.PA_ADMIN_PASS;
  const envPassHash = process.env.PA_ADMIN_PASS_HASH;

  if (envUser && (envPass || envPassHash)) {
    if (username !== envUser) return false;
    if (envPass) return password === envPass;
    return await bcrypt.compare(password, envPassHash!);
  }

  const auth = await loadAuthFile();
  if (username !== auth.username) return false;
  return await bcrypt.compare(password, auth.passwordHash);
}

declare module "express-session" {
  interface SessionData {
    user?: { username: string };
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session?.user) return next();
  res.status(401).json({ error: "unauthorized" });
}
