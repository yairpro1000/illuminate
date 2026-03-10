import { instrumentFetch } from '../../../shared/observability/backend.js';
import type { Logger } from '../lib/logger.js';

interface GoogleSaConfig {
  client_email: string;
  private_key: string;
  token_uri: string;
}

function b64url(input: string | Uint8Array): string {
  const raw = typeof input === 'string' ? input : String.fromCharCode(...input);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function signJwtRS256(pemPrivateKey: string, signingInput: string): Promise<string> {
  const pemBody = pemPrivateKey
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const derBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    derBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  return b64url(new Uint8Array(sig));
}

async function getAccessToken(config: GoogleSaConfig, scope: string, logger?: Logger): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss:   config.client_email,
    scope: scope,
    aud:   config.token_uri,
    iat:   now,
    exp:   now + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const sig = await signJwtRS256(config.private_key, signingInput);
  const jwt = `${signingInput}.${sig}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  const res = logger
    ? await instrumentFetch(logger, {
        provider: 'google_drive',
        operation: 'token_exchange',
        method: 'POST',
        url: config.token_uri,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
    : await fetch(config.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

export async function uploadToGoogleDrive(opts: {
  file: ArrayBuffer | Uint8Array;
  mimeType: string;
  filename: string;
  folderId: string;
  serviceAccount: GoogleSaConfig;
  logger?: Logger;
}): Promise<{ fileId: string }>
{
  const token = await getAccessToken(opts.serviceAccount, 'https://www.googleapis.com/auth/drive.file', opts.logger);
  const metadata = { name: opts.filename, parents: [opts.folderId] };

  const boundary = `----gd-${Math.random().toString(16).slice(2)}`;
  const delimiter = `--${boundary}`;
  const closeDelim = `--${boundary}--`;

  const metaPart = [
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
  ].join('\r\n');

  const bodyParts: (Uint8Array | string)[] = [];
  bodyParts.push(delimiter + '\r\n' + metaPart + '\r\n');
  bodyParts.push(delimiter + '\r\n' + `Content-Type: ${opts.mimeType}` + '\r\n' + '\r\n');
  bodyParts.push(new Uint8Array(opts.file instanceof ArrayBuffer ? opts.file : opts.file.buffer));
  bodyParts.push('\r\n' + closeDelim);

  // Compose as a Blob to avoid string concatenation of binary data
  const multipartBody = new Blob(bodyParts as any, { type: `multipart/related; boundary=${boundary}` });

  const res = opts.logger
    ? await instrumentFetch(opts.logger, {
        provider: 'google_drive',
        operation: 'upload',
        method: 'POST',
        url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        headers: { 'Authorization': `Bearer ${token}` },
        body: multipartBody,
      })
    : await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: multipartBody,
      });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Drive upload failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const data = await res.json() as { id: string };
  return { fileId: data.id };
}

async function driveApiCall(
  opts: {
    method: string;
    url: string;
    accessToken: string;
    body?: string;
    contentType?: string;
  },
  logger?: Logger,
): Promise<Response> {
  const headers: Record<string, string> = { 'Authorization': `Bearer ${opts.accessToken}` };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;

  if (logger) {
    return instrumentFetch(logger, {
      provider: 'google_drive',
      operation: 'api_call',
      method: opts.method,
      url: opts.url,
      headers,
      body: opts.body,
    });
  }
  return fetch(opts.url, { method: opts.method, headers, body: opts.body });
}

async function findFolderByName(
  name: string,
  parentId: string,
  accessToken: string,
  logger?: Logger,
): Promise<string | null> {
  const q = `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`;
  const res = await driveApiCall({ method: 'GET', url, accessToken }, logger);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Drive folder search failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const data = await res.json() as { files: Array<{ id: string }> };
  return data.files.length > 0 ? (data.files[0]?.id ?? null) : null;
}

async function createDriveFolder(
  name: string,
  parentId: string | null,
  accessToken: string,
  logger?: Logger,
): Promise<string> {
  const metadata: Record<string, unknown> = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) metadata.parents = [parentId];
  const url = 'https://www.googleapis.com/drive/v3/files?fields=id';
  const res = await driveApiCall(
    { method: 'POST', url, accessToken, body: JSON.stringify(metadata), contentType: 'application/json' },
    logger,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Drive folder creation failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const data = await res.json() as { id: string };
  return data.id;
}

/**
 * Resolves a two-level Drive folder path, creating folders as needed.
 * Returns the ID of the leaf subfolder.
 *
 * If rootFolderId is provided it is used directly as the parent for subfolder lookup.
 * Otherwise the function finds/creates a `rootFolderName` folder at Drive root first.
 */
export async function getOrCreateDriveFolderPath(opts: {
  rootFolderName: string;
  rootFolderId?: string | null;
  subfolderName: string;
  serviceAccount: GoogleSaConfig;
  logger?: Logger;
}): Promise<string> {
  const token = await getAccessToken(
    opts.serviceAccount,
    'https://www.googleapis.com/auth/drive',
    opts.logger,
  );

  let parentId: string;
  if (opts.rootFolderId) {
    parentId = opts.rootFolderId;
  } else {
    const found = await findFolderByName(opts.rootFolderName, 'root', token, opts.logger);
    parentId = found ?? await createDriveFolder(opts.rootFolderName, null, token, opts.logger);
  }

  const found = await findFolderByName(opts.subfolderName, parentId, token, opts.logger);
  return found ?? createDriveFolder(opts.subfolderName, parentId, token, opts.logger);
}

export function resolveServiceAccountFromEnv(env: {
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_CLIENT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
  GOOGLE_TOKEN_URI?: string;
}): GoogleSaConfig {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const obj = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return {
      client_email: obj.client_email,
      private_key: obj.private_key,
      token_uri: obj.token_uri || 'https://oauth2.googleapis.com/token',
    };
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
