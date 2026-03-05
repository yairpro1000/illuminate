export type Env = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  PA_LLM_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
};

export function mustEnv(env: Env, key: keyof Env): string {
  const v = env[key];
  if (!v) throw new Error(`Missing env var ${String(key)}`);
  return String(v);
}

