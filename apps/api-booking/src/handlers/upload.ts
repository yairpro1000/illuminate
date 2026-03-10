import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { requireAdminAccess } from '../lib/admin-access.js';
import { resolveServiceAccountFromEnv, uploadToGoogleDrive, getOrCreateDriveFolderPath } from '../lib/google-drive.js';

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

    // ── Google Drive backup ──────────────────────────────────────────────────
    let driveFileId: string | null = null;
    try {
      log('drive: resolving service account');
      const sa = resolveServiceAccountFromEnv(ctx.env);
      log('drive: service account resolved', { clientEmail: sa.client_email });

      const driveSubfolder = entityType === 'event' ? 'events' : 'session_types';
      const rootFolderId = ctx.env.GOOGLE_DRIVE_FOLDER_ID || null;
      log('drive: resolving images folder', { rootFolderName: 'illuminate-website', rootFolderId, subfolderName: 'images' });

      let imagesFolderId: string;
      try {
        imagesFolderId = await getOrCreateDriveFolderPath({
          rootFolderName: 'illuminate-website',
          rootFolderId,
          subfolderName: 'images',
          serviceAccount: sa,
          logger: ctx.logger,
        });
        log('drive: images folder resolved', { imagesFolderId });
      } catch (e) {
        err('drive: failed to resolve images folder', e);
        throw e;
      }

      log('drive: resolving entity subfolder', { subfolderName: driveSubfolder, parentId: imagesFolderId });
      let folderId: string;
      try {
        folderId = await getOrCreateDriveFolderPath({
          rootFolderName: 'images',
          rootFolderId: imagesFolderId,
          subfolderName: driveSubfolder,
          serviceAccount: sa,
          logger: ctx.logger,
        });
        log('drive: entity folder resolved', { folderId, driveSubfolder });
      } catch (e) {
        err('drive: failed to resolve entity subfolder', e);
        throw e;
      }

      log('drive: uploading file', { filename, folderId, mimeType, bytes: arrayBuffer.byteLength });
      try {
        const result = await uploadToGoogleDrive({ file: arrayBuffer, mimeType, filename, folderId, serviceAccount: sa, logger: ctx.logger });
        driveFileId = result.fileId;
        log('drive: upload succeeded', { driveFileId });
      } catch (e) {
        err('drive: file upload failed', e);
        throw e;
      }
    } catch (e) {
      // Drive is optional — log but don't fail the request
      err('drive: backup skipped due to error (R2 already succeeded)', e);
      ctx.logger.captureException?.({ eventType: 'drive_backup_failed', message: 'Google Drive backup failed', error: e, context: { key } });
    }

    const base = (ctx.env.IMAGE_BASE_URL || '').replace(/\/+$/g, '');
    const url = base ? `${base}/${key}` : null;
    log('done', { key, driveFileId, url });

    return ok({ image_key: key, drive_file_id: driveFileId, url });
  } catch (e) {
    err('unhandled error', e);
    return errorResponse(e);
  }
}
