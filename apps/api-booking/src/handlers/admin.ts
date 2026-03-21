import type { AppContext } from '../router.js';
import type { Env } from '../env.js';
import type { AdminContactMessageFilters, OrganizerBookingFilters } from '../providers/repository/interface.js';
import type {
  BookingCurrentStatus,
  EventMarketingContent,
  EventUpdate,
  NewSystemSetting,
  PaymentStatus,
  SystemSetting,
  SystemSettingUpdate,
  SystemSettingValueType,
} from '../types.js';
import { ApiError, conflict, created, badRequest, notFound, ok } from '../lib/errors.js';
import { requireAdminAccess } from '../lib/admin-access.js';
import { normalizeEventMarketingContent } from '../lib/content-status.js';
import { getBookingPolicyConfig } from '../domain/booking-effect-policy.js';
import {
  isPaymentContinuableOnline,
  isPaymentManualArrangementStatus,
  isPaymentSettledStatus,
} from '../domain/payment-status.js';
import { BOOKING_POLICY_CONFIG_SOURCE } from '../config/booking-policy.js';
import { generateToken, hashToken } from '../services/token-service.js';
import {
  buildAdminManageUrl,
  buildManageUrl,
  settleBookingPaymentManually,
} from '../services/booking-service.js';
import {
  SERVICE_MODES,
  getAllOverrides,
  setOverride,
  clearOverride,
  type ServiceKey,
} from '../lib/config-overrides.js';

const SYSTEM_SETTING_VALUE_TYPES: readonly SystemSettingValueType[] = [
  'integer',
  'float',
  'boolean',
  'text',
  'json',
];

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function coerceNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatEventDisplay(startsAt: string, timezone: string): string {
  return new Date(startsAt).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  });
}

function buildLateAccessUrl(event: {
  slug: string;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  address_line: string;
  is_paid: boolean;
  price_per_person: number | null;
}, siteUrl: string, token: string): string {
  const params = new URLSearchParams({
    source: 'evening',
    eventSlug: event.slug,
    eventTitle: event.title,
    eventDate: event.starts_at.slice(0, 10),
    eventDisplay: formatEventDisplay(event.starts_at, event.timezone),
    eventStart: event.starts_at,
    eventEnd: event.ends_at,
    eventLocation: event.address_line,
    isPaid: String(event.is_paid),
    price: String(event.price_per_person ?? 0),
    access: token,
  });
  return `${siteUrl.replace(/\/+$/g, '')}/book.html?${params.toString()}`;
}

function parseBookingFilters(url: URL): OrganizerBookingFilters {
  const source = url.searchParams.get('source');
  const eventId = url.searchParams.get('event_id');
  const date = url.searchParams.get('date');
  const clientId = url.searchParams.get('client_id');
  const status = url.searchParams.get('status');

  return {
    booking_kind: source === 'event' || source === 'session' ? source : undefined,
    event_id: eventId?.trim() || undefined,
    date: date?.trim() || undefined,
    client_id: clientId?.trim() || undefined,
    current_status: status?.trim() as OrganizerBookingFilters['current_status'] | undefined,
  };
}

function parseContactMessageFilters(url: URL): AdminContactMessageFilters {
  const date = url.searchParams.get('date');
  const clientId = url.searchParams.get('client_id');
  const q = url.searchParams.get('q');
  return {
    date: date?.trim() || undefined,
    client_id: clientId?.trim() || undefined,
    q: q?.trim() || undefined,
  };
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await request.json() as Record<string, unknown>;
  }

  const raw = await request.text();
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function coerceRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') throw badRequest(`${fieldName} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw badRequest(`${fieldName} is required`);
  return trimmed;
}

function coerceOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function coerceOptionalPrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw badRequest('booking.price must be a non-negative number');
  return Math.round(parsed * 100) / 100;
}

function parseAdminPaymentStatus(value: unknown): PaymentStatus | null {
  if (typeof value !== 'string') return null;
  if (value === 'CASH_OK') return value;
  throw badRequest('payment.status only supports CASH_OK through the booking edit endpoint');
}

function isDuplicateClientEmailError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('code=23505')
    && message.includes('email');
}

function normalizeSystemSettingValue(value: string, valueType: SystemSettingValueType): string {
  switch (valueType) {
    case 'integer': {
      if (!/^-?\d+$/.test(value)) throw badRequest('value must be a valid integer');
      return String(parseInt(value, 10));
    }
    case 'float': {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw badRequest('value must be a valid number');
      return String(parsed);
    }
    case 'boolean': {
      const normalized = value.trim().toLowerCase();
      if (normalized !== 'true' && normalized !== 'false') {
        throw badRequest('value must be true or false for boolean settings');
      }
      return normalized;
    }
    case 'json': {
      try {
        return JSON.stringify(JSON.parse(value));
      } catch {
        throw badRequest('value must be valid JSON');
      }
    }
    case 'text':
    default:
      return value;
  }
}

function parseSystemSettingValueType(value: unknown): SystemSettingValueType {
  if (typeof value !== 'string' || !SYSTEM_SETTING_VALUE_TYPES.includes(value as SystemSettingValueType)) {
    throw badRequest('value_type must be one of integer, float, boolean, text, json');
  }
  return value as SystemSettingValueType;
}

function parseSystemSettingPayload(body: Record<string, unknown>): NewSystemSetting {
  const domain = coerceRequiredString(body.domain, 'domain');
  const keyname = coerceRequiredString(body.keyname, 'keyname');
  const readable_name = coerceRequiredString(body.readable_name, 'readable_name');
  const value_type = parseSystemSettingValueType(body.value_type);
  const rawValue = typeof body.value === 'string' ? body.value : String(body.value ?? '');
  const value = normalizeSystemSettingValue(rawValue, value_type);
  const description = coerceRequiredString(body.description, 'description');
  const description_he = coerceOptionalString(body.description_he);
  const unit = coerceOptionalString(body.unit);

  return {
    domain,
    keyname,
    readable_name,
    value_type,
    unit,
    value,
    description,
    description_he,
  };
}

function sortSystemSettingsByValue(settings: SystemSetting[]): SystemSetting[] {
  return settings.slice().sort((a, b) => {
    const aNum = Number(a.value);
    const bNum = Number(b.value);
    const aIsNum = Number.isFinite(aNum);
    const bIsNum = Number.isFinite(bNum);
    if (aIsNum && bIsNum) {
      return aNum - bNum || a.readable_name.localeCompare(b.readable_name);
    }
    if (aIsNum) return -1;
    if (bIsNum) return 1;
    return a.value.localeCompare(b.value) || a.readable_name.localeCompare(b.readable_name);
  });
}

function toAdminSystemSettingRow(setting: SystemSetting) {
  return {
    domain: setting.domain,
    name: setting.readable_name,
    readable_name: setting.readable_name,
    keyname: setting.keyname,
    value_type: setting.value_type,
    unit: setting.unit,
    value: setting.value,
    description: setting.description,
    description_he: setting.description_he,
    description_display: setting.description_he ?? setting.description,
    created_at: setting.created_at,
    updated_at: setting.updated_at,
  };
}

function isServiceOverridePayload(body: Record<string, unknown>): body is { key: ServiceKey; mode: string } {
  return typeof body.key === 'string' && typeof body.mode === 'string';
}

// GET /api/admin/events
export async function handleAdminGetEvents(request: Request, ctx: AppContext): Promise<Response> {
  try {
    ctx.logger.logInfo({
      eventType: 'admin_events_request',
      message: 'Admin events auth starting',
      context: {
        path: new URL(request.url).pathname,
        admin_auth_disabled: /^(1|true|yes|on)$/i.test(String(ctx.env.ADMIN_AUTH_DISABLED ?? '').trim()),
      },
    });
    await requireAdminAccess(request, ctx.env, ctx.logger);
    const events = await ctx.providers.repository.getAllEvents();
    return ok({
      events: events.map((event) => ({
        id: event.id,
        slug: event.slug,
        title: event.title,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        status: event.status,
      })),
    });
  } catch (err) {
    ctx.logger.logWarn({
      eventType: 'admin_events_request_failed',
      message: err instanceof Error ? err.message : String(err),
      context: {
        path: new URL(request.url).pathname,
        admin_auth_disabled: /^(1|true|yes|on)$/i.test(String(ctx.env.ADMIN_AUTH_DISABLED ?? '').trim()),
        status_code: (err as { statusCode?: number })?.statusCode ?? 500,
        auth_failure_reason: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

// GET /api/admin/events/all  (all events for admin edit-offers page)
export async function handleAdminGetAllEvents(request: Request, ctx: AppContext): Promise<Response> {
  try {
    await requireAdminAccess(request, ctx.env);
    const events = await ctx.providers.repository.getAllEvents();
    return ok({ events });
  } catch (err) {
    throw err;
  }
}

// PATCH /api/admin/events/:eventId
export async function handleAdminUpdateEvent(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    await requireAdminAccess(request, ctx.env);
    const eventId = params.eventId?.trim();
    if (!eventId) throw badRequest('eventId is required');

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_event_update_started',
      message: 'Started admin event update request',
      context: {
        path,
        event_id: eventId,
        branch_taken: 'load_event_and_parse_patch',
      },
    });

    const event = await ctx.providers.repository.getEventById(eventId);
    if (!event) throw notFound('Event not found');

    const body = await parseJsonBody(request);
    const updates: EventUpdate = {};
    const allowed: Array<keyof EventUpdate> = [
      'slug', 'title', 'description', 'marketing_content', 'starts_at', 'ends_at', 'timezone',
      'location_name', 'address_line', 'maps_url', 'is_paid', 'price_per_person',
      'currency', 'capacity', 'status', 'image_key', 'drive_file_id', 'image_alt',
      'whatsapp_group_invite_url',
    ];
    for (const f of allowed) {
      if (f in body) (updates as Record<string, unknown>)[f] = body[f];
    }

    const marketingContentInput = Object.prototype.hasOwnProperty.call(body, 'marketing_content')
      ? coerceEventMarketingContent(body.marketing_content)
      : undefined;
    if (marketingContentInput !== undefined) updates.marketing_content = marketingContentInput;

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_event_update_patch_decision',
      message: 'Evaluated admin event update payload',
      context: {
        path,
        event_id: event.id,
        changed_fields: Object.keys(updates),
        has_marketing_content: marketingContentInput !== undefined,
        marketing_has_subtitle: Boolean(marketingContentInput?.subtitle),
        marketing_has_intro: Boolean(marketingContentInput?.intro),
        marketing_what_to_expect_count: marketingContentInput?.what_to_expect?.length ?? 0,
        marketing_takeaways_count: marketingContentInput?.takeaways?.length ?? 0,
        branch_taken: 'apply_event_updates',
        deny_reason: null,
      },
    });

    const updated = await ctx.providers.repository.updateEvent(eventId, updates);
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_event_update_completed',
      message: 'Completed admin event update request',
      context: {
        path,
        event_id: updated.id,
        changed_fields: Object.keys(updates),
        marketing_content_present: Boolean(updated.marketing_content),
        branch_taken: 'return_updated_event',
        deny_reason: null,
      },
    });
    return ok({ event: updated });
  } catch (err) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'admin_event_update_failed',
      message: err instanceof Error ? err.message : String(err),
      context: {
        path,
        event_id: params.eventId?.trim() || null,
        branch_taken: 'propagate_error_to_shared_wrapper',
        deny_reason: err instanceof Error ? err.message : String(err),
        status_code: (err as { statusCode?: number })?.statusCode ?? 500,
      },
    });
    throw err;
  }
}

function coerceEventMarketingContent(value: unknown): EventMarketingContent {
  if (value === null) return {};
  const normalized = normalizeEventMarketingContent(value);
  if (normalized) return normalized;
  if (value && typeof value === 'object' && !Array.isArray(value)) return {};
  throw badRequest('marketing_content must be an object');
}

// GET /api/admin/bookings
export async function handleAdminGetBookings(request: Request, ctx: AppContext): Promise<Response> {
  try {
    await requireAdminAccess(request, ctx.env);
    const filters = parseBookingFilters(new URL(request.url));
    const rows = await ctx.providers.repository.getOrganizerBookings(filters);
    return ok({ rows });
  } catch (err) {
    throw err;
  }
}

// GET /api/admin/contact-messages
export async function handleAdminGetContactMessages(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    const filters = parseContactMessageFilters(new URL(request.url));
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_contact_messages_request_started',
      message: 'Starting admin contact-message listing request',
      context: {
        path,
        branch_taken: 'auth_check_pending',
        has_date_filter: Boolean(filters.date),
        has_client_filter: Boolean(filters.client_id),
        has_text_filter: Boolean(filters.q),
      },
    });
    await requireAdminAccess(request, ctx.env, ctx.logger);
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_contact_messages_auth_passed',
      message: 'Admin contact-message listing auth passed',
      context: {
        path,
        branch_taken: 'fetch_contact_messages',
        filter_date: filters.date ?? null,
        filter_client_id: filters.client_id ?? null,
        filter_q: filters.q ?? null,
      },
    });
    const rows = await ctx.providers.repository.getAdminContactMessages(filters);
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_contact_messages_request_succeeded',
      message: 'Admin contact-message listing request succeeded',
      context: {
        path,
        branch_taken: 'return_rows',
        row_count: rows.length,
        filter_date: filters.date ?? null,
        filter_client_id: filters.client_id ?? null,
        filter_q: filters.q ?? null,
      },
    });
    return ok({ rows });
  } catch (err) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'admin_contact_messages_request_failed',
      message: err instanceof Error ? err.message : String(err),
      context: {
        path,
        branch_taken: 'propagate_error_to_shared_wrapper',
        deny_reason: err instanceof Error ? err.message : String(err),
        status_code: (err as { statusCode?: number })?.statusCode ?? 500,
      },
    });
    throw err;
  }
}

// PATCH /api/admin/bookings/:bookingId
export async function handleAdminUpdateBooking(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    await requireAdminAccess(request, ctx.env);
    const bookingId = params.bookingId?.trim();
    if (!bookingId) throw badRequest('bookingId is required');

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_booking_update_started',
      message: 'Started admin booking update request',
      context: {
        path,
        booking_id: bookingId,
        branch_taken: 'load_booking_and_parse_patch',
      },
    });

    const booking = await ctx.providers.repository.getBookingById(bookingId);
    if (!booking) throw notFound('Booking not found');

    const body = await parseJsonBody(request);
    const clientPatch = typeof body.client === 'object' && body.client !== null
      ? body.client as Record<string, unknown>
      : null;
    const bookingPatch = typeof body.booking === 'object' && body.booking !== null
      ? body.booking as Record<string, unknown>
      : null;
    const paymentPatch = typeof body.payment === 'object' && body.payment !== null
      ? body.payment as Record<string, unknown>
      : null;

    if (!clientPatch && !bookingPatch && !paymentPatch) {
      throw badRequest('No changes provided');
    }

    const existingPayment = await ctx.providers.repository.getPaymentByBookingId(booking.id);

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_booking_update_patch_decision',
      message: 'Evaluated admin booking update patch content',
      context: {
        path,
        booking_id: booking.id,
        has_client_patch: Boolean(clientPatch),
        has_booking_patch: Boolean(bookingPatch),
        has_payment_patch: Boolean(paymentPatch),
        has_client_email_patch: Boolean(clientPatch && typeof clientPatch.email === 'string' && clientPatch.email.trim()),
        branch_taken: 'apply_requested_booking_and_client_updates',
      },
    });

    if (clientPatch) {
      const updates: Record<string, string | null> = {};
      if (typeof clientPatch.first_name === 'string' && clientPatch.first_name.trim()) {
        updates.first_name = clientPatch.first_name.trim();
      }
      if (clientPatch.last_name === null || typeof clientPatch.last_name === 'string') {
        updates.last_name = coerceNullableString(clientPatch.last_name);
      }
      if (typeof clientPatch.email === 'string' && clientPatch.email.trim()) {
        updates.email = normalizeEmail(clientPatch.email);
      }
      if (clientPatch.phone === null || typeof clientPatch.phone === 'string') {
        updates.phone = coerceNullableString(clientPatch.phone);
      }
      if (Object.keys(updates).length > 0) {
        ctx.logger.logInfo?.({
          source: 'backend',
          eventType: 'admin_booking_update_client_patch_started',
          message: 'Started admin client update for booking edit',
          context: {
            path,
            booking_id: booking.id,
            client_id: booking.client_id,
            has_email_update: typeof updates.email === 'string',
            has_phone_update: Object.prototype.hasOwnProperty.call(updates, 'phone'),
            has_first_name_update: typeof updates.first_name === 'string',
            has_last_name_update: Object.prototype.hasOwnProperty.call(updates, 'last_name'),
            branch_taken: 'update_client_record',
          },
        });
        await ctx.providers.repository.updateClient(booking.client_id, updates);
      }
    }

    if (bookingPatch) {
      const updates: { notes?: string | null; current_status?: BookingCurrentStatus; price?: number } = {};
      if (bookingPatch.notes === null || typeof bookingPatch.notes === 'string') {
        updates.notes = bookingPatch.notes === null ? null : bookingPatch.notes.slice(0, 4000);
      }
      if (typeof bookingPatch.current_status === 'string') {
        updates.current_status = bookingPatch.current_status as BookingCurrentStatus;
      }
      if (Object.prototype.hasOwnProperty.call(bookingPatch, 'price')) {
        const parsedPrice = coerceOptionalPrice(bookingPatch.price);
        if (parsedPrice === null) throw badRequest('booking.price is required when provided');
        if (existingPayment && isPaymentSettledStatus(existingPayment.status)) {
          throw conflict('Cannot edit booking price after payment settlement');
        }
        updates.price = parsedPrice;
      }
      if (Object.keys(updates).length > 0) {
        ctx.logger.logInfo?.({
          source: 'backend',
          eventType: 'admin_booking_update_booking_patch_started',
          message: 'Started admin booking field update',
          context: {
            path,
            booking_id: booking.id,
            has_notes_update: Object.prototype.hasOwnProperty.call(updates, 'notes'),
            has_status_update: typeof updates.current_status === 'string',
            has_price_update: typeof updates.price === 'number',
            branch_taken: 'update_booking_record',
          },
        });
        await ctx.providers.repository.updateBooking(booking.id, updates);
      }

      if (typeof updates.price === 'number' && existingPayment && !isPaymentSettledStatus(existingPayment.status)) {
        let invoiceUpdate: {
          stripe_customer_id?: string | null;
          stripe_invoice_id?: string | null;
          stripe_payment_intent_id?: string | null;
          stripe_payment_link_id?: string | null;
          invoice_url?: string | null;
          raw_payload?: Record<string, unknown>;
        } = {};

        if (booking.booking_type === 'PAY_LATER' && booking.client_email) {
          const invoice = await ctx.providers.payments.createInvoice({
            title: booking.session_type_title ?? booking.event_title ?? 'ILLUMINATE Booking',
            amount: updates.price,
            currency: booking.currency,
            bookingId: booking.id,
            customerEmail: booking.client_email,
            customerName: [booking.client_first_name, booking.client_last_name].filter(Boolean).join(' ') || booking.client_email,
            existingStripeCustomerId: existingPayment.stripe_customer_id,
            idempotencyKey: `booking:${booking.id}:admin-regenerate-invoice`,
            metadata: {
              booking_id: booking.id,
              booking_kind: booking.event_id ? 'event' : 'session',
              payment_kind: 'pay_later',
            },
          });
          invoiceUpdate = {
            stripe_customer_id: invoice.customerId,
            stripe_invoice_id: invoice.invoiceId,
            stripe_payment_intent_id: invoice.paymentIntentId,
            stripe_payment_link_id: invoice.paymentLinkId,
            invoice_url: invoice.invoiceUrl,
            raw_payload: {
              ...(existingPayment.raw_payload ?? {}),
              invoice_response: invoice.rawPayload ?? null,
              regenerated_by: 'admin_booking_price_edit',
            },
          };
        }

        ctx.logger.logInfo?.({
          source: 'backend',
          eventType: 'admin_booking_update_payment_amount_sync_started',
          message: 'Synchronizing payment amount with edited booking price',
          context: {
            path,
            booking_id: booking.id,
            payment_id: existingPayment.id,
            payment_status: existingPayment.status,
            booking_price: updates.price,
            payment_amount_before: existingPayment.amount,
            payment_amount_after: updates.price,
            invoice_regenerated: Boolean(invoiceUpdate.invoice_url),
            branch_taken: 'sync_payment_amount_to_booking_price',
          },
        });
        await ctx.providers.repository.updatePayment(existingPayment.id, {
          amount: updates.price,
          currency: booking.currency,
          ...invoiceUpdate,
        });
      }
    }

    if (paymentPatch) {
      const requestedStatus = parseAdminPaymentStatus(paymentPatch.status);
      if (requestedStatus === 'CASH_OK') {
        if (!existingPayment) throw conflict('Cannot approve manual payment arrangement without a payment record');
        if (isPaymentSettledStatus(existingPayment.status)) {
          throw conflict('Cannot approve manual payment arrangement after payment settlement');
        }
        ctx.logger.logInfo?.({
          source: 'backend',
          eventType: 'admin_booking_update_payment_status_started',
          message: 'Started admin payment status update',
          context: {
            path,
            booking_id: booking.id,
            payment_id: existingPayment.id,
            prior_payment_status: existingPayment.status,
            requested_payment_status: requestedStatus,
            branch_taken: isPaymentManualArrangementStatus(existingPayment.status)
              ? 'keep_existing_manual_arrangement'
              : 'set_manual_payment_arrangement',
            deny_reason: null,
          },
        });
        if (!isPaymentManualArrangementStatus(existingPayment.status)) {
          await ctx.providers.repository.updatePayment(existingPayment.id, { status: 'CASH_OK' });
        }
      }
    }

    const refreshedRows = await ctx.providers.repository.getOrganizerBookings({ client_id: booking.client_id });
    const refreshed = refreshedRows.find((row) => row.booking_id === booking.id) ?? null;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_booking_update_completed',
      message: 'Completed admin booking update request',
      context: {
        path,
        booking_id: booking.id,
        client_id: booking.client_id,
        branch_taken: 'return_updated_booking',
      },
    });
    return ok({ ok: true, booking: refreshed });
  } catch (err) {
    const normalizedError = isDuplicateClientEmailError(err)
      ? conflict('A client with this email already exists')
      : err;
    const statusCode = normalizedError instanceof ApiError ? normalizedError.statusCode : 500;
    const errorCode = normalizedError instanceof ApiError ? normalizedError.code : 'INTERNAL_ERROR';
    const errorMessage = normalizedError instanceof Error ? normalizedError.message : String(normalizedError);

    ctx.operation.latestInboundErrorCode = errorCode;
    ctx.operation.latestInboundErrorMessage = errorMessage;

    if (statusCode >= 500) {
      ctx.logger.captureException?.({
        source: 'backend',
        eventType: 'admin_booking_update_failed',
        message: 'Admin booking update failed unexpectedly',
        error: normalizedError,
        context: {
          path,
          booking_id: params.bookingId?.trim() || null,
          status_code: statusCode,
          branch_taken: 'unexpected_exception',
        },
      });
    } else {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'admin_booking_update_failed',
        message: errorMessage,
        context: {
          path,
          booking_id: params.bookingId?.trim() || null,
          status_code: statusCode,
          error_code: errorCode,
          branch_taken: 'handled_api_error',
          deny_reason: errorCode,
        },
      });
    }

    throw normalizedError;
  }
}

// POST /api/admin/bookings/:bookingId/payment-settled
export async function handleAdminSettleBookingPayment(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_booking_payment_settlement_started',
      message: 'Started admin manual payment settlement request',
      context: {
        path,
        booking_id: params.bookingId?.trim() || null,
        branch_taken: 'authorize_and_validate_booking_payment_state',
      },
    });
    await requireAdminAccess(request, ctx.env, ctx.logger);
    const bookingId = params.bookingId?.trim();
    if (!bookingId) throw badRequest('bookingId is required');

    const booking = await ctx.providers.repository.getBookingById(bookingId);
    if (!booking) throw notFound('Booking not found');
    const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
    if (!payment) throw conflict('Payment record not found');

    const body = await parseJsonBody(request);
    const note = coerceOptionalString(body.note);
    const invoiceUrl = coerceOptionalString(body.invoice_url) ?? payment.invoice_url;
    const invoiceId = coerceOptionalString(body.invoice_id)
      ?? payment.stripe_invoice_id
      ?? null;
    const settledAt = coerceOptionalString(body.paid_at);

    const denyReason = isPaymentSettledStatus(payment.status)
      ? 'payment_already_settled'
      : payment.status === 'REFUNDED'
        ? 'payment_refunded'
        : isPaymentContinuableOnline(payment.status) || isPaymentManualArrangementStatus(payment.status)
          ? null
          : 'payment_status_not_settleable';

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_booking_payment_settlement_decision',
      message: 'Evaluated admin manual payment settlement eligibility',
      context: {
        path,
        booking_id: booking.id,
        payment_id: payment.id,
        booking_status: booking.current_status,
        booking_type: booking.booking_type,
        payment_status: payment.status,
        has_invoice_url: Boolean(invoiceUrl),
        branch_taken: denyReason ? 'deny_manual_payment_settlement' : 'allow_manual_payment_settlement',
        deny_reason: denyReason,
      },
    });

    if (booking.booking_type === 'FREE') throw conflict('Free bookings do not support payment settlement');
    if (!['PENDING', 'CONFIRMED'].includes(booking.current_status)) {
      throw conflict('Only pending or confirmed bookings can be settled manually');
    }
    if (denyReason) throw conflict('Payment cannot be settled from its current state');

    await settleBookingPaymentManually(
      payment,
      {
        invoiceUrl,
        invoiceId,
        note,
        settledAt,
      },
      {
        providers: ctx.providers,
        env: ctx.env,
        logger: ctx.logger,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        operation: ctx.operation,
        siteUrl: ctx.siteUrl,
      },
    );

    const refreshedRows = await ctx.providers.repository.getOrganizerBookings({ client_id: booking.client_id });
    const refreshed = refreshedRows.find((row) => row.booking_id === booking.id) ?? null;
    return ok({ ok: true, booking: refreshed });
  } catch (err) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'admin_booking_payment_settlement_failed',
      message: err instanceof Error ? err.message : String(err),
      context: {
        path,
        booking_id: params.bookingId?.trim() || null,
        status_code: (err as { statusCode?: number })?.statusCode ?? 500,
        branch_taken: err instanceof ApiError ? 'handled_api_error' : 'propagate_error_to_shared_wrapper',
        deny_reason: err instanceof ApiError ? err.code : (err instanceof Error ? err.message : String(err)),
      },
    });
    throw err;
  }
}

// POST /api/admin/bookings/:bookingId/manage-link
export async function handleAdminCreateBookingManageLink(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    await requireAdminAccess(request, ctx.env);
    const bookingId = params.bookingId?.trim();
    if (!bookingId) throw badRequest('bookingId is required');
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_manage_link_create_started',
      message: 'Starting admin manage-link generation',
      context: {
        path,
        booking_id: bookingId,
        has_admin_manage_token_secret: Boolean(String(ctx.env.ADMIN_MANAGE_TOKEN_SECRET ?? '').trim()),
        has_job_secret: Boolean(String(ctx.env.JOB_SECRET ?? '').trim()),
        branch_taken: 'resolve_booking_and_build_manage_link',
      },
    });
    const booking = await ctx.providers.repository.getBookingById(bookingId);
    if (!booking) throw notFound('Booking not found');
    const link = await buildAdminManageUrl(booking, {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
      siteUrl: ctx.siteUrl,
    });
    return ok({
      booking_id: booking.id,
      url: link.url,
      expires_at: link.expiresAt,
    });
  } catch (err) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'admin_manage_link_create_failed',
      message: err instanceof Error ? err.message : String(err),
      context: {
        path,
        booking_id: params.bookingId ?? null,
        status_code: (err as { statusCode?: number })?.statusCode ?? 500,
        branch_taken: err instanceof Error ? 'handled_error' : 'non_error_throwable',
        deny_reason: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

// POST /api/admin/bookings/:bookingId/client-manage-link
export async function handleAdminCreateClientManageLink(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    await requireAdminAccess(request, ctx.env);
    const bookingId = params.bookingId?.trim();
    if (!bookingId) throw badRequest('bookingId is required');
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_client_manage_link_create_started',
      message: 'Starting client manage-link generation for admin share flow',
      context: {
        path,
        booking_id: bookingId,
        branch_taken: 'resolve_booking_and_build_client_manage_link',
      },
    });
    const booking = await ctx.providers.repository.getBookingById(bookingId);
    if (!booking) throw notFound('Booking not found');
    const url = await buildManageUrl(ctx.siteUrl, booking);
    return ok({
      booking_id: booking.id,
      url,
    });
  } catch (err) {
    ctx.logger.logWarn?.({
      source: 'backend',
      eventType: 'admin_client_manage_link_create_failed',
      message: err instanceof Error ? err.message : String(err),
      context: {
        path,
        booking_id: params.bookingId ?? null,
        status_code: (err as { statusCode?: number })?.statusCode ?? 500,
        branch_taken: err instanceof Error ? 'handled_error' : 'non_error_throwable',
        deny_reason: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

// POST /api/admin/events/:eventId/late-access-links
export async function handleAdminCreateLateAccessLink(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
): Promise<Response> {
  try {
    await requireAdminAccess(request, ctx.env);
    const eventId = params.eventId?.trim();
    if (!eventId) throw badRequest('eventId is required');

    const event = await ctx.providers.repository.getEventById(eventId);
    if (!event) throw notFound('Event not found');

    const rawToken = generateToken();
    const tokenHash = await hashToken(rawToken);
    const policy = await getBookingPolicyConfig(ctx.providers.repository);
    const expiresAt = new Date(
      new Date(event.ends_at).getTime() + policy.eventLateAccessLinkExpiryHours * 60 * 60_000,
    ).toISOString();

    await ctx.providers.repository.revokeActiveEventLateAccessLinks(event.id);
    await ctx.providers.repository.createEventLateAccessLink({
      event_id: event.id,
      token_hash: tokenHash,
      expires_at: expiresAt,
      created_by_client_id: null,
    });

    return created({
      event_id: event.id,
      expires_at: expiresAt,
      url: buildLateAccessUrl(event, ctx.siteUrl, rawToken),
    });
  } catch (err) {
    throw err;
  }
}

// GET /api/admin/config
export async function handleAdminGetConfig(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_config_request_started',
      message: 'Started admin config request handling',
      context: {
        path,
        request_id: ctx.requestId,
        branch_taken: 'authorize_then_build_admin_config',
      },
    });

    await requireAdminAccess(request, ctx.env, ctx.logger);
    const settings = sortSystemSettingsByValue(await ctx.providers.repository.listSystemSettings());
    const domains = await ctx.providers.repository.listSystemSettingDomains();
    const overrides = getAllOverrides();
    const services = SERVICE_MODES.map(({ key, label, modes }) => {
      const envMode = getEnvMode(key, ctx.env);
      const overrideMode = overrides[key] ?? null;
      const effectiveMode = overrideMode ?? envMode;
      return { key, label, effective_mode: effectiveMode, env_mode: envMode, override_mode: overrideMode, modes };
    });
    const timingDelays = {
      config_source: BOOKING_POLICY_CONFIG_SOURCE,
      entries: settings.map(toAdminSystemSettingRow),
      domains,
      value_types: SYSTEM_SETTING_VALUE_TYPES,
    };

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_config_request_decision',
      message: 'Prepared admin config payload',
      context: {
        path,
        request_id: ctx.requestId,
        service_count: services.length,
        timing_delay_count: timingDelays.entries.length,
        config_source: timingDelays.config_source,
        branch_taken: 'allow_admin_config_response',
        deny_reason: null,
      },
    });

    const responseBody = { services, timing_delays: timingDelays };

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_config_response_ready',
      message: 'Admin config response ready',
      context: {
        path,
        request_id: ctx.requestId,
        service_count: services.length,
        timing_delay_count: timingDelays.entries.length,
        branch_taken: 'admin_config_response_prepared',
      },
    });

    return ok(responseBody);
  } catch (err) {
    const path = new URL(request.url).pathname;
    const statusCode = err instanceof ApiError ? err.statusCode : 500;
    if (err instanceof ApiError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'admin_config_request_failed',
        message: err.message,
        context: {
          path,
          request_id: ctx.requestId,
          status_code: statusCode,
          error_code: err.code,
          branch_taken: 'handled_api_error',
          deny_reason: err.code,
        },
      });
    } else {
      ctx.logger.captureException?.({
        source: 'backend',
        eventType: 'uncaught_exception',
        message: 'Admin config request failed unexpectedly',
        error: err,
        context: {
          path,
          request_id: ctx.requestId,
          status_code: statusCode,
          branch_taken: 'unexpected_exception',
        },
      });
    }
    throw err;
  }
}

// PATCH /api/admin/config
export async function handleAdminPatchConfig(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_config_mutation_started',
      message: 'Started admin config mutation handling',
      context: {
        path,
        request_id: ctx.requestId,
        branch_taken: 'authorize_then_route_admin_config_mutation',
      },
    });

    await requireAdminAccess(request, ctx.env, ctx.logger);
    const body = await parseJsonBody(request);
    if (isServiceOverridePayload(body)) {
      const key = body.key;
      const mode = body.mode;
      const serviceDef = SERVICE_MODES.find((s) => s.key === key);
      if (!serviceDef) throw badRequest(`Unknown service: ${key}`);

      const modeDef = serviceDef.modes.find((m) => m.value === mode);
      if (!modeDef) throw badRequest(`Unknown mode '${mode}' for service '${key}'`);
      if (!modeDef.wired) throw badRequest(`Mode '${mode}' is not yet wired for '${key}'`);

      if (mode === getEnvMode(key, ctx.env)) {
        clearOverride(key);
      } else {
        setOverride(key, mode);
      }

      const overrides = getAllOverrides();
      const envMode = getEnvMode(key, ctx.env);
      ctx.logger.logInfo?.({
        source: 'backend',
        eventType: 'admin_config_mutation_decision',
        message: 'Applied admin service override mutation',
        context: {
          path,
          request_id: ctx.requestId,
          mutation_scope: 'service_override',
          service_key: key,
          requested_mode: mode,
          effective_mode: overrides[key] ?? envMode,
          branch_taken: 'service_override_updated',
          deny_reason: null,
        },
      });
      return ok({
        key,
        effective_mode: overrides[key] ?? envMode,
        env_mode: envMode,
        override_mode: overrides[key] ?? null,
      });
    }

    const setting = parseSystemSettingPayload(body);
    const existingKeyname = request.method === 'PATCH'
      ? coerceRequiredString(body.original_keyname ?? body.keyname, 'original_keyname')
      : null;
    const mutationScope = existingKeyname ? 'system_setting_update' : 'system_setting_create';
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'admin_config_mutation_decision',
      message: 'Validated admin system setting mutation payload',
      context: {
        path,
        request_id: ctx.requestId,
        mutation_scope: mutationScope,
        original_keyname: existingKeyname,
        keyname: setting.keyname,
        domain: setting.domain,
        value_type: setting.value_type,
        branch_taken: existingKeyname ? 'apply_system_setting_update' : 'apply_system_setting_create',
        deny_reason: null,
      },
    });

    const saved = existingKeyname
      ? await ctx.providers.repository.updateSystemSetting(existingKeyname, setting as SystemSettingUpdate)
      : await ctx.providers.repository.createSystemSetting(setting as NewSystemSetting);

    const settings = sortSystemSettingsByValue(await ctx.providers.repository.listSystemSettings());
    const domains = await ctx.providers.repository.listSystemSettingDomains();

    return ok({
      setting: toAdminSystemSettingRow(saved),
      timing_delays: {
        config_source: BOOKING_POLICY_CONFIG_SOURCE,
        entries: settings.map(toAdminSystemSettingRow),
        domains,
        value_types: SYSTEM_SETTING_VALUE_TYPES,
      },
    });
  } catch (err) {
    const path = new URL(request.url).pathname;
    const statusCode = err instanceof ApiError ? err.statusCode : 500;
    if (err instanceof ApiError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'admin_config_mutation_failed',
        message: err.message,
        context: {
          path,
          request_id: ctx.requestId,
          status_code: statusCode,
          error_code: err.code,
          branch_taken: 'handled_api_error',
          deny_reason: err.code,
        },
      });
    } else {
      ctx.logger.captureException?.({
        source: 'backend',
        eventType: 'uncaught_exception',
        message: 'Admin config mutation failed unexpectedly',
        error: err,
        context: {
          path,
          request_id: ctx.requestId,
          status_code: statusCode,
          branch_taken: 'unexpected_exception',
        },
      });
    }
    throw err;
  }
}

function getEnvMode(key: ServiceKey, env: Env): string {
  const map: Record<ServiceKey, string> = {
    repository: env.REPOSITORY_MODE,
    email:      env.EMAIL_MODE,
    calendar:   env.CALENDAR_MODE,
    payments:   env.PAYMENTS_MODE,
    antibot:    env.ANTIBOT_MODE,
  };
  return map[key];
}

// POST /api/admin/reminder-subscriptions
export async function handleAdminCreateReminderSubscription(
  request: Request,
  ctx: AppContext,
): Promise<Response> {
  try {
    await requireAdminAccess(request, ctx.env);
    const body = await request.json() as Record<string, unknown>;
    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    if (!email) throw badRequest('email is required');

    const subscription = await ctx.providers.repository.createOrUpdateEventReminderSubscription({
      email,
      first_name: coerceNullableString(body.first_name),
      last_name: coerceNullableString(body.last_name),
      phone: coerceNullableString(body.phone),
      event_family: coerceNullableString(body.event_family) ?? 'illuminate_evenings',
    });

    return created({
      ok: true,
      id: subscription.id,
      email: subscription.email,
      event_family: subscription.event_family,
    });
  } catch (err) {
    throw err;
  }
}
