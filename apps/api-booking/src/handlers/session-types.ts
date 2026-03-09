import type { AppContext } from '../router.js';
import { ok, created, badRequest, errorResponse } from '../lib/errors.js';
import { requireAdminAccess } from '../lib/admin-access.js';

// GET /api/session-types (public)
export async function handleGetSessionTypes(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    const rows = await ctx.providers.repository.getPublicSessionTypes();
    return ok({ session_types: rows });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/admin/session-types
export async function handleAdminGetSessionTypes(request: Request, ctx: AppContext): Promise<Response> {
  try {
    requireAdminAccess(request, ctx.env);
    const rows = await ctx.providers.repository.getAllSessionTypes();
    return ok({ session_types: rows });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/admin/session-types
export async function handleAdminCreateSessionType(request: Request, ctx: AppContext): Promise<Response> {
  try {
    requireAdminAccess(request, ctx.env);
    const body = await request.json() as Record<string, any>;
    const required = ['title', 'slug', 'description', 'duration_minutes', 'price'];
    for (const f of required) if (!body[f]) throw badRequest(`${f} is required`);
    const payload = {
      title: String(body.title).trim(),
      slug: String(body.slug).trim(),
      short_description: body.short_description ? String(body.short_description) : null,
      description: String(body.description),
      duration_minutes: Number(body.duration_minutes) | 0,
      price: Number(body.price) | 0,
      currency: String(body.currency || 'CHF'),
      status: (body.status === 'draft' || body.status === 'active' || body.status === 'hidden') ? body.status : 'draft',
      sort_order: Number(body.sort_order ?? 0) | 0,
      image_key: body.image_key ? String(body.image_key) : null,
      drive_file_id: body.drive_file_id ? String(body.drive_file_id) : null,
      image_alt: body.image_alt ? String(body.image_alt) : null,
    };
    const row = await ctx.providers.repository.createSessionType(payload as any);
    return created({ session_type: row });
  } catch (err) {
    return errorResponse(err);
  }
}

// PATCH /api/admin/session-types/:id
export async function handleAdminUpdateSessionType(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  try {
    requireAdminAccess(request, ctx.env);
    const id = params.id?.trim();
    if (!id) throw badRequest('id is required');
    const body = await request.json() as Record<string, any>;
    const updates: Record<string, any> = {};
    for (const key of [
      'title','slug','short_description','description','duration_minutes','price','currency','status','sort_order','image_key','drive_file_id','image_alt'
    ]) {
      if (key in body) updates[key] = body[key];
    }
    const row = await ctx.providers.repository.updateSessionType(id, updates as any);
    return ok({ session_type: row });
  } catch (err) {
    return errorResponse(err);
  }
}
