import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

export type Db = SupabaseClient;

export function makeSupabase(env: Env): Db {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
