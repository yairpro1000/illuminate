export type Env = {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  SITE_URL?: string;
  SITE_DEFAULT_ADDRESS_LINE?: string;
  SITE_DEFAULT_MAPS_URL?: string;
  API_ALLOWED_ORIGINS?: string;
  ADMIN_ALLOWED_EMAILS?: string;
  // Local dev helper: if set, allows bypassing Cloudflare Access on localhost only.
  PA_DEV_EMAIL?: string;
  // Preview helper: if set, allows Pages preview origins to call the workers.dev host without Access.
  PA_PREVIEW_DEV_EMAIL?: string;
  PA_LLM_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  AI: Ai;
  GOOGLE_TTS_API_KEY?: string;
  RESEND_API_KEY?: string;
};

export function mustEnv(env: Env, key: keyof Env): string {
  const v = env[key];
  if (!v) throw new Error(`Missing env var ${String(key)}`);
  return String(v);
}
