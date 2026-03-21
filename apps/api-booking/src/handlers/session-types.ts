import type { AppContext } from '../router.js';
import { ApiError, ok, created, badRequest, notFound } from '../lib/errors.js';
import { requireAdminAccess } from '../lib/admin-access.js';
import { normalizeSessionTypeRow } from '../lib/content-status.js';
import {
  buildSessionTypeAvailabilityWeekSummaries,
  loadSessionTypeAvailabilityDetails,
} from '../services/session-availability.js';
import type {
  NewSessionTypeAvailabilityWindow,
  SessionTypeAvailabilityMode,
  SessionTypeWeekOverrideMode,
} from '../types.js';

function parseNonNegativePrice(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw badRequest(`${fieldName} must be a non-negative number`);
  }
  return Number(parsed.toFixed(2));
}

function parsePositiveIntegerOrNull(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseAvailabilityMode(value: unknown): SessionTypeAvailabilityMode {
  return value === 'dedicated' ? 'dedicated' : 'shared_default';
}

function parseWeekOverrideMode(value: unknown): SessionTypeWeekOverrideMode {
  if (value === 'FORCE_OPEN' || value === 'FORCE_CLOSED' || value === 'AUTO') {
    return value;
  }
  throw badRequest('mode must be AUTO, FORCE_OPEN, or FORCE_CLOSED');
}

function parseLocalTime(value: unknown, fieldName: string): string {
  const raw = String(value ?? '').trim();
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(raw);
  if (!match) {
    throw badRequest(`${fieldName} must use HH:MM format`);
  }
  return `${match[1]}:${match[2]}:00`;
}

function parseAvailabilityWindows(value: unknown): NewSessionTypeAvailabilityWindow[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw badRequest(`availability.windows[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    const weekday = Number(row.weekday_iso);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw badRequest(`availability.windows[${index}].weekday_iso must be 1-7`);
    }
    return {
      session_type_id: '',
      weekday_iso: weekday,
      start_local_time: parseLocalTime(row.start_local_time, `availability.windows[${index}].start_local_time`),
      end_local_time: parseLocalTime(row.end_local_time, `availability.windows[${index}].end_local_time`),
      sort_order: Number.isInteger(Number(row.sort_order)) ? Number(row.sort_order) : index,
      active: row.active === undefined ? true : Boolean(row.active),
    };
  });
}

function parseAvailabilityPayload(body: Record<string, unknown>): {
  mode: SessionTypeAvailabilityMode;
  timezone: string | null;
  weekly_booking_limit: number | null;
  slot_step_minutes: number | null;
  windows: NewSessionTypeAvailabilityWindow[];
} | null {
  if (!('availability' in body)) return null;
  const availability = body.availability;
  if (!availability || typeof availability !== 'object' || Array.isArray(availability)) {
    throw badRequest('availability must be an object');
  }
  const payload = availability as Record<string, unknown>;
  return {
    mode: parseAvailabilityMode(payload.mode),
    timezone: typeof payload.timezone === 'string' && payload.timezone.trim()
      ? payload.timezone.trim()
      : null,
    weekly_booking_limit: parsePositiveIntegerOrNull(payload.weekly_booking_limit, 'availability.weekly_booking_limit'),
    slot_step_minutes: parsePositiveIntegerOrNull(payload.slot_step_minutes, 'availability.slot_step_minutes'),
    windows: parseAvailabilityWindows(payload.windows),
  };
}

async function buildSessionTypeDetailPayload(ctx: AppContext, id: string) {
  const sessionType = await ctx.providers.repository.getSessionTypeById(id);
  if (!sessionType) {
    throw notFound('Session type not found');
  }
  const availability = await loadSessionTypeAvailabilityDetails(
    ctx.providers.repository,
    sessionType,
    ctx.env.TIMEZONE ?? 'Europe/Zurich',
  );
  const upcomingWeeks = await buildSessionTypeAvailabilityWeekSummaries(
    ctx.providers.repository,
    sessionType,
    availability.timezone,
    8,
  );
  return {
    session_type: normalizeSessionTypeRow(sessionType),
    availability: {
      mode: availability.mode,
      timezone: availability.timezone,
      weekly_booking_limit: availability.weeklyBookingLimit,
      slot_step_minutes: availability.slotStepMinutes,
      windows: availability.windows,
      upcoming_weeks: upcomingWeeks.map((week) => ({
        week_start_date: week.weekStartDate,
        week_end_exclusive_date: week.weekEndExclusiveDate,
        mode: week.overrideMode,
        override_weekly_booking_limit: week.overrideWeeklyLimit,
        effective_weekly_booking_limit: week.effectiveWeeklyLimit,
        active_booking_count: week.activeBookingCount,
        remaining_capacity: week.remainingCapacity,
        branch_taken: week.branchTaken,
        deny_reason: week.denyReason,
        note: week.note,
        updated_by: week.updatedBy,
      })),
    },
  };
}

function parseSessionTypeMutationBody(body: Record<string, unknown>) {
  const payload = {
    title: String(body.title).trim(),
    slug: String(body.slug).trim(),
    short_description: body.short_description ? String(body.short_description) : null,
    description: String(body.description),
    duration_minutes: Number(body.duration_minutes) | 0,
    price: parseNonNegativePrice(body.price, 'price'),
    currency: String(body.currency || 'CHF'),
    status: (body.status === 'draft' || body.status === 'active' || body.status === 'hidden') ? body.status : 'draft',
    sort_order: Number(body.sort_order ?? 0) | 0,
    image_key: body.image_key ? String(body.image_key) : null,
    drive_file_id: body.drive_file_id ? String(body.drive_file_id) : null,
    image_alt: body.image_alt ? String(body.image_alt) : null,
  };
  const availability = parseAvailabilityPayload(body);
  return {
    payload: {
      ...payload,
      ...(availability
        ? {
            availability_mode: availability.mode,
            availability_timezone: availability.timezone,
            weekly_booking_limit: availability.weekly_booking_limit,
            slot_step_minutes: availability.slot_step_minutes,
          }
        : {}),
    },
    availability,
  };
}

function logAdminSessionTypeFailure(
  ctx: AppContext,
  eventType: string,
  request: Request,
  error: unknown,
  extras: Record<string, unknown> = {},
) {
  const path = new URL(request.url).pathname;
  const statusCode = error instanceof ApiError ? error.statusCode : 500;
  const logMethod = error instanceof ApiError ? ctx.logger.logWarn : ctx.logger.captureException;
  logMethod?.call(ctx.logger, error instanceof ApiError
    ? {
        source: 'backend',
        eventType,
        message: error.message,
        context: {
          path,
          request_id: ctx.requestId,
          status_code: statusCode,
          branch_taken: 'handled_api_error',
          deny_reason: error.code,
          ...extras,
        },
      }
    : {
        source: 'backend',
        eventType: 'uncaught_exception',
        message: 'Admin session-type request failed unexpectedly',
        error,
        context: {
          path,
          request_id: ctx.requestId,
          status_code: statusCode,
          branch_taken: 'unexpected_exception',
          ...extras,
        },
      });
}

// GET /api/session-types (public)
export async function handleGetSessionTypes(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'public_session_types_request_started',
    message: 'Loading public session types',
    context: {
      path,
      repository_mode: ctx.env.REPOSITORY_MODE,
      branch_taken: 'load_public_session_types',
    },
  });
  try {
    const rows = (await ctx.providers.repository.getPublicSessionTypes()).map((row) => normalizeSessionTypeRow(row));
    const statusCounts = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'public_session_types_request_completed',
      message: 'Loaded public session types',
      context: {
        path,
        repository_mode: ctx.env.REPOSITORY_MODE,
        returned_session_type_count: rows.length,
        session_type_status_counts: statusCounts,
        branch_taken: rows.length > 0 ? 'return_public_session_types' : 'return_empty_public_session_types',
        deny_reason: null,
      },
    });
    return ok({ session_types: rows });
  } catch (err) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'public_session_types_request_failed',
      message: err instanceof Error ? err.message : String(err),
      context: {
        path,
        repository_mode: ctx.env.REPOSITORY_MODE,
        branch_taken: 'propagate_error_to_shared_wrapper',
        deny_reason: err instanceof Error ? err.name : 'unknown_error',
      },
    });
    throw err;
  }
}

// GET /api/admin/session-types
export async function handleAdminGetSessionTypes(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'admin_session_types_request_started',
    message: 'Started admin session-types list request',
    context: {
      path,
      request_id: ctx.requestId,
      branch_taken: 'authorize_then_list_session_types',
    },
  });
  try {
    await requireAdminAccess(request, ctx.env, ctx.logger);
    const rows = await ctx.providers.repository.getAllSessionTypes();
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_session_types_request_completed',
      message: 'Completed admin session-types list request',
      context: {
        path,
        request_id: ctx.requestId,
        returned_session_type_count: rows.length,
        branch_taken: rows.length > 0 ? 'return_admin_session_types' : 'return_empty_admin_session_types',
        deny_reason: null,
      },
    });
    return ok({ session_types: rows });
  } catch (error) {
    logAdminSessionTypeFailure(ctx, 'admin_session_types_request_failed', request, error);
    throw error;
  }
}

// GET /api/admin/session-types/:id
export async function handleAdminGetSessionTypeDetail(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const id = params.id?.trim() || '';
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'admin_session_type_detail_request_started',
    message: 'Started admin session-type detail request',
    context: {
      path,
      request_id: ctx.requestId,
      session_type_id: id || null,
      branch_taken: 'authorize_then_load_session_type_detail',
    },
  });
  try {
    await requireAdminAccess(request, ctx.env, ctx.logger);
    if (!id) throw badRequest('id is required');
    const payload = await buildSessionTypeDetailPayload(ctx, id);
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_session_type_detail_request_completed',
      message: 'Completed admin session-type detail request',
      context: {
        path,
        request_id: ctx.requestId,
        session_type_id: payload.session_type.id,
        availability_mode: payload.availability.mode,
        returned_window_count: payload.availability.windows.length,
        returned_week_summary_count: payload.availability.upcoming_weeks.length,
        branch_taken: 'return_admin_session_type_detail',
        deny_reason: null,
      },
    });
    return ok(payload);
  } catch (error) {
    logAdminSessionTypeFailure(ctx, 'admin_session_type_detail_request_failed', request, error, {
      session_type_id: id || null,
    });
    throw error;
  }
}

// POST /api/admin/session-types
export async function handleAdminCreateSessionType(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'admin_session_type_mutation_started',
    message: 'Started admin session-type create mutation',
    context: {
      path,
      request_id: ctx.requestId,
      mutation_scope: 'session_type_create',
      branch_taken: 'authorize_then_validate_session_type_create',
    },
  });
  try {
    await requireAdminAccess(request, ctx.env, ctx.logger);
    const body = await request.json() as Record<string, unknown>;
    const required = ['title', 'slug', 'description', 'duration_minutes', 'price'];
    for (const field of required) {
      if (!body[field]) throw badRequest(`${field} is required`);
    }
    const { payload, availability } = parseSessionTypeMutationBody(body);
    const row = await ctx.providers.repository.createSessionType(payload as any);
    if (availability) {
      await ctx.providers.repository.replaceSessionTypeAvailabilityWindows(
        row.id,
        availability.windows.map((window) => ({ ...window, session_type_id: row.id })),
      );
    }
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_session_type_mutation_completed',
      message: 'Completed admin session-type create mutation',
      context: {
        path,
        request_id: ctx.requestId,
        mutation_scope: 'session_type_create',
        session_type_id: row.id,
        availability_mode: row.availability_mode,
        window_count: availability?.windows.length ?? 0,
        branch_taken: 'session_type_created',
        deny_reason: null,
      },
    });
    return created({ session_type: row });
  } catch (error) {
    logAdminSessionTypeFailure(ctx, 'admin_session_type_mutation_failed', request, error, {
      mutation_scope: 'session_type_create',
    });
    throw error;
  }
}

// PATCH /api/admin/session-types/:id
export async function handleAdminUpdateSessionType(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const id = params.id?.trim() || '';
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'admin_session_type_mutation_started',
    message: 'Started admin session-type update mutation',
    context: {
      path,
      request_id: ctx.requestId,
      mutation_scope: 'session_type_update',
      session_type_id: id || null,
      branch_taken: 'authorize_then_validate_session_type_update',
    },
  });
  try {
    await requireAdminAccess(request, ctx.env, ctx.logger);
    if (!id) throw badRequest('id is required');
    const body = await request.json() as Record<string, unknown>;
    const { payload, availability } = parseSessionTypeMutationBody(body);
    const row = await ctx.providers.repository.updateSessionType(id, payload as any);
    if (availability) {
      await ctx.providers.repository.replaceSessionTypeAvailabilityWindows(
        id,
        availability.windows.map((window) => ({ ...window, session_type_id: id })),
      );
    }
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_session_type_mutation_completed',
      message: 'Completed admin session-type update mutation',
      context: {
        path,
        request_id: ctx.requestId,
        mutation_scope: 'session_type_update',
        session_type_id: row.id,
        availability_mode: row.availability_mode,
        window_count: availability?.windows.length ?? null,
        branch_taken: availability ? 'session_type_and_availability_updated' : 'session_type_updated',
        deny_reason: null,
      },
    });
    return ok({ session_type: row });
  } catch (error) {
    logAdminSessionTypeFailure(ctx, 'admin_session_type_mutation_failed', request, error, {
      mutation_scope: 'session_type_update',
      session_type_id: id || null,
    });
    throw error;
  }
}

// PUT /api/admin/session-types/:id/availability-overrides/:weekStartDate
export async function handleAdminUpsertSessionTypeAvailabilityOverride(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const id = params.id?.trim() || '';
  const weekStartDate = params.weekStartDate?.trim() || '';
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'admin_session_type_availability_override_mutation_started',
    message: 'Started admin session-type availability override mutation',
    context: {
      path,
      request_id: ctx.requestId,
      session_type_id: id || null,
      week_start_date: weekStartDate || null,
      branch_taken: 'authorize_then_validate_week_override_mutation',
    },
  });
  try {
    await requireAdminAccess(request, ctx.env, ctx.logger);
    if (!id) throw badRequest('id is required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartDate)) {
      throw badRequest('weekStartDate must be YYYY-MM-DD');
    }
    const body = await request.json() as Record<string, unknown>;
    const row = await ctx.providers.repository.upsertSessionTypeWeekOverride({
      session_type_id: id,
      week_start_date: weekStartDate,
      mode: parseWeekOverrideMode(body.mode),
      override_weekly_booking_limit: parsePositiveIntegerOrNull(
        body.override_weekly_booking_limit,
        'override_weekly_booking_limit',
      ),
      note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
      updated_by: request.headers.get('Cf-Access-Authenticated-User-Email'),
    });
    const payload = await buildSessionTypeDetailPayload(ctx, id);
    const summary = payload.availability.upcoming_weeks.find((week) => week.week_start_date === weekStartDate) ?? null;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_session_type_availability_override_mutation_completed',
      message: 'Completed admin session-type availability override mutation',
      context: {
        path,
        request_id: ctx.requestId,
        session_type_id: id,
        week_start_date: weekStartDate,
        override_mode: row.mode,
        override_weekly_booking_limit: row.override_weekly_booking_limit,
        branch_taken: 'session_type_week_override_upserted',
        deny_reason: null,
      },
    });
    return ok({
      override: row,
      week_summary: summary,
    });
  } catch (error) {
    logAdminSessionTypeFailure(ctx, 'admin_session_type_availability_override_mutation_failed', request, error, {
      session_type_id: id || null,
      week_start_date: weekStartDate || null,
    });
    throw error;
  }
}
