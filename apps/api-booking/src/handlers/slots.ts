import type { AppContext } from '../router.js';
import { badRequest, internalError, jsonResponse } from '../lib/errors.js';
import { getBookingPolicyConfig } from '../domain/booking-effect-policy.js';
import { listAvailableSessionTypeSlots } from '../services/session-availability.js';

type SlotType = 'intro' | 'session';

function requireIsoDate(value: string | null, fieldName: string): string {
  if (!value) throw badRequest(`${fieldName} query param is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`${fieldName} must be YYYY-MM-DD`);
  }
  return value;
}

function resolveSlotType(raw: string | null): SlotType {
  if (!raw) throw badRequest('type query param is required');
  if (raw !== 'intro' && raw !== 'session') {
    throw badRequest('type must be "intro" or "session"');
  }
  return raw;
}

export async function handleGetSlots(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  const url = new URL(request.url);
  const from = requireIsoDate(url.searchParams.get('from'), 'from');
  const to = requireIsoDate(url.searchParams.get('to'), 'to');
  const tz = url.searchParams.get('tz') ?? ctx.env.TIMEZONE ?? 'Europe/Zurich';
  const slotType = resolveSlotType(url.searchParams.get('type'));
  const offerSlug = url.searchParams.get('offer_slug')?.trim() || null;
  const sessionTypeId = url.searchParams.get('session_type_id')?.trim() || null;

  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'session_type_availability_request_started',
    message: 'Started public session availability request',
    context: {
      path,
      request_id: ctx.requestId,
      from,
      to,
      requested_timezone: tz,
      requested_slot_type: slotType,
      offer_slug: offerSlug,
      session_type_id: sessionTypeId,
      branch_taken: 'load_public_session_type_availability',
      deny_reason: null,
    },
  });

  try {
    const policy = await getBookingPolicyConfig(ctx.providers.repository);
    const [busyTimes, heldSlots] = await Promise.all([
      ctx.providers.calendar.getBusyTimes(from, to).catch((error) => {
        ctx.logger.logWarn?.({
          source: 'backend',
          eventType: 'session_type_availability_dependency_failed',
          message: error instanceof Error ? error.message : String(error),
          context: {
            path,
            request_id: ctx.requestId,
            dependency: 'calendar',
            branch_taken: 'deny_calendar_busy_times_unavailable',
            deny_reason: 'calendar_unavailable',
          },
        });
        throw internalError('Calendar temporarily unavailable');
      }),
      ctx.providers.repository.getHeldSlots(from, to).catch((error) => {
        ctx.logger.logWarn?.({
          source: 'backend',
          eventType: 'session_type_availability_dependency_failed',
          message: error instanceof Error ? error.message : String(error),
          context: {
            path,
            request_id: ctx.requestId,
            dependency: 'repository',
            branch_taken: 'deny_held_slots_unavailable',
            deny_reason: 'repository_unavailable',
          },
        });
        throw internalError('Calendar temporarily unavailable');
      }),
    ]);

    const result = await listAvailableSessionTypeSlots(ctx.providers.repository, {
      from,
      to,
      kind: slotType,
      requestedTimezone: tz,
      fallbackTimezone: ctx.env.TIMEZONE ?? tz,
      offerSlug,
      sessionTypeId,
      busyTimes,
      heldSlots,
      slotLeadTimeHours: policy.slotLeadTimeHours,
    });

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'session_type_availability_request_completed',
      message: 'Completed public session availability request',
      context: {
        path,
        request_id: ctx.requestId,
        from,
        to,
        requested_timezone: tz,
        effective_timezone: result.timezone,
        requested_slot_type: slotType,
        session_type_id: result.sessionType.id,
        session_type_slug: result.sessionType.slug,
        availability_mode: result.sessionType.availability_mode,
        weekly_booking_limit: result.sessionType.weekly_booking_limit,
        returned_slot_count: result.slots.length,
        branch_taken: result.slots.length > 0
          ? 'return_session_type_slots'
          : 'return_empty_session_type_slots',
        deny_reason: null,
      },
    });

    return jsonResponse({
      ok: true,
      timezone: result.timezone,
      session_type_id: result.sessionType.id,
      session_type_slug: result.sessionType.slug,
      slots: result.slots,
    });
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'session_type_availability_request_failed',
        message: error.message,
        context: {
          path,
          request_id: ctx.requestId,
          from,
          to,
          requested_timezone: tz,
          requested_slot_type: slotType,
          offer_slug: offerSlug,
          session_type_id: sessionTypeId,
          branch_taken: 'propagate_api_error_to_shared_wrapper',
          deny_reason: (error as { code?: string }).code ?? 'unknown_api_error',
        },
      });
    } else {
      ctx.logger.captureException?.({
        source: 'backend',
        eventType: 'uncaught_exception',
        message: 'Session availability request failed unexpectedly',
        error,
        context: {
          path,
          request_id: ctx.requestId,
          from,
          to,
          requested_timezone: tz,
          requested_slot_type: slotType,
          offer_slug: offerSlug,
          session_type_id: sessionTypeId,
          branch_taken: 'unexpected_session_type_availability_failure',
        },
      });
    }
    throw error;
  }
}
