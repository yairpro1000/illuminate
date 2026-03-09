import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makeSupabaseAdminClient } from "../../../shared/supabase/client.js";
import type { Env } from "../env.js";

export type Db = SupabaseClient;

export function makeSupabase(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_SECRET_KEY">): Db {
  return makeSupabaseAdminClient(createClient, {
    url: env.SUPABASE_URL,
    secretKey: env.SUPABASE_SECRET_KEY,
  });
}
