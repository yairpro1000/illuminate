import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

export type Db = SupabaseClient;

export function makeSupabase(env: Env): Db {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

