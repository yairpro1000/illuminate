import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { requireAdminAccess } from '../lib/admin-access.js';
// import { resolveServiceAccountFromEnv, uploadToGoogleDrive, getOrCreateDriveFolderPath } from '../lib/google-drive.js'; // Drive backup disabled — service accounts have no storage quota

function getExtFromMime(mime: string): string | null {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  return map[mime] ?? null;
}

function isFileUpload(value: unknown): value is File {
  return typeof File !== 'undefined' && value !== null && typeof value !== 'string' && value instanceof File;
}

export async function handleAdminUploadImage(request: Request, ctx: AppContext): Promise<Response> {
  const log = (msg: string, data?: unknown) =>
    console.log(`[upload] ${msg}`, data !== undefined ? JSON.stringify(data) : '');
  const err = (msg: string, e: unknown) => {
    const detail = e instanceof Error
      ? { message: e.message, stack: e.stack, name: e.name }
      : { raw: String(e) };
    console.error(`[upload] ${msg}`, JSON.stringify(detail));
  };

  try {
    await requireAdminAccess(request, ctx.env);

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      throw badRequest('content-type must be multipart/form-data');
    }

    const form = await request.formData();
    const file = form.get('file');
    const entityType = String(form.get('entity_type') || '').trim();
    if (!isFileUpload(file)) throw badRequest('file is required');
    if (entityType !== 'event' && entityType !== 'session') throw badRequest('entity_type must be event | session');

    const mimeType = file.type || 'application/octet-stream';
    const ext = getExtFromMime(mimeType) || (file.name.split('.').pop() || 'bin');
    const shortId = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(b => (b % 36).toString(36)).join('');
    const rawBase = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'image';
    const filename = `${shortId}-${rawBase}.${ext}`;
    const r2Folder = entityType === 'event' ? 'events' : 'session_types';
    const key = `${r2Folder}/${filename}`;

    log('parsed', { entityType, originalName: file.name, mimeType, ext, filename, key, sizeBytes: file.size });

    // ── R2 upload ────────────────────────────────────────────────────────────
    log('r2: starting put', { key, mimeType });
    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
      await ctx.env.IMAGES_BUCKET.put(key, arrayBuffer, { httpMetadata: { contentType: mimeType } });
      log('r2: put succeeded', { key, bytes: arrayBuffer.byteLength });
    } catch (e) {
      err('r2: put failed', e);
      throw e; // R2 is required — propagate
    }

    // ── Google Drive backup (disabled — service accounts have no storage quota) ──
    // To re-enable: use a Shared Drive (Workspace) or personal OAuth token.
    // const driveFileId: string | null = null;
    const driveFileId: string | null = null;

    const base = (ctx.env.IMAGE_BASE_URL || '').replace(/\/+$/g, '');
    const url = base ? `${base}/${key}` : null;
    log('done', { key, driveFileId, url });

    return ok({ image_key: key, drive_file_id: driveFileId, url });
  } catch (e) {
    err('unhandled error', e);
    return errorResponse(e);
  }
}
