export interface GoogleServiceAccountConfig {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export interface GoogleServiceAccountEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_CLIENT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
  GOOGLE_TOKEN_URI?: string;
}

const DEFAULT_GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

function parseGoogleServiceAccountJson(serviceAccountJson: string): GoogleServiceAccountConfig {
  const parsed = JSON.parse(serviceAccountJson) as {
    client_email?: unknown;
    private_key?: unknown;
    token_uri?: unknown;
  };

  if (typeof parsed.client_email !== 'string' || !parsed.client_email.trim()) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email');
  }
  if (typeof parsed.private_key !== 'string' || !parsed.private_key.trim()) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing private_key');
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: typeof parsed.token_uri === 'string' && parsed.token_uri.trim()
      ? parsed.token_uri
      : DEFAULT_GOOGLE_TOKEN_URI,
  };
}

export function resolveGoogleServiceAccountJsonConfig(env: Pick<GoogleServiceAccountEnv, 'GOOGLE_SERVICE_ACCOUNT_JSON'>): GoogleServiceAccountConfig {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required for Google Calendar service-account authentication');
  }

  return parseGoogleServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

export function resolveGoogleServiceAccountConfig(env: GoogleServiceAccountEnv): GoogleServiceAccountConfig {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return parseGoogleServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  if (!env.GOOGLE_CLIENT_EMAIL || !env.GOOGLE_PRIVATE_KEY || !env.GOOGLE_TOKEN_URI) {
    throw new Error('Missing Google service account configuration');
  }

  return {
    client_email: env.GOOGLE_CLIENT_EMAIL,
    private_key: env.GOOGLE_PRIVATE_KEY,
    token_uri: env.GOOGLE_TOKEN_URI,
  };
}
