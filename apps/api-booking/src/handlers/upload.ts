import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { requireAdminAccess } from '../lib/admin-access.js';
import { resolveServiceAccountFromEnv, uploadToGoogleDrive } from '../lib/google-drive.js';

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

    const uuid = crypto.randomUUID();
    const mimeType = file.type || 'application/octet-stream';
    const ext = getExtFromMime(mimeType) || (file.name.split('.').pop() || 'bin');
    const prefix = entityType === 'event' ? 'events/' : 'sessions/';
    const key = `${prefix}${uuid}.${ext}`;

    // Upload to R2
    const arrayBuffer = await file.arrayBuffer();
    await ctx.env.IMAGES_BUCKET.put(key, arrayBuffer, {
      httpMetadata: { contentType: mimeType },
    });

    // Optional: Drive backup
    let driveFileId: string | null = null;
    try {
      if (ctx.env.GOOGLE_DRIVE_FOLDER_ID) {
        const sa = resolveServiceAccountFromEnv(ctx.env);
        const { fileId } = await uploadToGoogleDrive({
          file: arrayBuffer,
          mimeType,
          filename: `${uuid}.${ext}`,
          folderId: ctx.env.GOOGLE_DRIVE_FOLDER_ID,
          serviceAccount: sa,
          logger: ctx.logger,
        });
        driveFileId = fileId;
      }
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
