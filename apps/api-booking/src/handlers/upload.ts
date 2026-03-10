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

    // Upload to R2
    const arrayBuffer = await file.arrayBuffer();
    await ctx.env.IMAGES_BUCKET.put(key, arrayBuffer, {
      httpMetadata: { contentType: mimeType },
    });

    // Optional: Drive backup
    let driveFileId: string | null = null;
    try {
      const sa = resolveServiceAccountFromEnv(ctx.env);
      const driveSubfolder = entityType === 'event' ? 'events' : 'session_types';
      const imagesFolderId = await getOrCreateDriveFolderPath({
        rootFolderName: 'illuminate-website',
        rootFolderId: ctx.env.GOOGLE_DRIVE_FOLDER_ID || null,
        subfolderName: 'images',
        serviceAccount: sa,
        logger: ctx.logger,
      });
      const folderId = await getOrCreateDriveFolderPath({
        rootFolderName: 'images',
        rootFolderId: imagesFolderId,
        subfolderName: driveSubfolder,
        serviceAccount: sa,
        logger: ctx.logger,
      });
      const { fileId } = await uploadToGoogleDrive({
        file: arrayBuffer,
        mimeType,
        filename,
        folderId,
        serviceAccount: sa,
        logger: ctx.logger,
      });
      driveFileId = fileId;
    } catch (e) {
      // Log but don't fail the request — R2 is source of truth
      ctx.logger.captureException?.({
        eventType: 'drive_backup_failed',
        message: 'Google Drive backup failed',
        error: e,
        context: { key },
      });
    }

    const base = (ctx.env.IMAGE_BASE_URL || '').replace(/\/+$/g, '');
    const url = base ? `${base}/${key}` : null;

    return ok({ image_key: key, drive_file_id: driveFileId, url });
  } catch (err) {
    return errorResponse(err);
  }
}
