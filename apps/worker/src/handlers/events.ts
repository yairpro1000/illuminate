import type { AppContext } from '../router.js';
import { ok, notFound, errorResponse } from '../lib/errors.js';

// GET /api/events
export async function handleGetEvents(_request: Request, ctx: AppContext): Promise<Response> {
  try {
    const events = await ctx.providers.repository.getPublishedEvents();
    return ok({ events });
  } catch (err) {
    return errorResponse(err);
  }
}

// GET /api/events/:slug
export async function handleGetEvent(
  _request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const slug = params['slug'];
    if (!slug) throw notFound();
    const event = await ctx.providers.repository.getEventBySlug(slug);
    if (!event) throw notFound('Event not found');
    return ok({ event });
  } catch (err) {
    return errorResponse(err);
  }
}
