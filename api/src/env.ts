export type Env = {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  // Local dev helper: if set, allows bypassing Cloudflare Access on localhost only.
  PA_DEV_EMAIL?: string;
  PA_LLM_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  AI: Ai;
};

export function mustEnv(env: Env, key: keyof Env): string {
  const v = env[key];
  if (!v) throw new Error(`Missing env var ${String(key)}`);
  return String(v);
}
