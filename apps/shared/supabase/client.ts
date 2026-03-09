export interface SupabaseAdminClientConfig {
  url: string;
  secretKey: string;
}

export interface SupabaseAdminClientOptions {
  auth: {
    persistSession: boolean;
    autoRefreshToken: boolean;
    detectSessionInUrl: boolean;
  };
}

export const SUPABASE_ADMIN_CLIENT_OPTIONS: SupabaseAdminClientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

export function makeSupabaseAdminClient<TClient>(
  createClientFn: (url: string, key: string, options: SupabaseAdminClientOptions) => TClient,
  config: SupabaseAdminClientConfig,
): TClient {
  return createClientFn(config.url, config.secretKey, SUPABASE_ADMIN_CLIENT_OPTIONS);
}
