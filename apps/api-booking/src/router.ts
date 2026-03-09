import type { Env } from './env.js';
import type { Providers } from './providers/index.js';
import type { Logger } from './lib/logger.js';
import { headerByteLength } from '../../shared/observability/backend.js';

import { handleGetSlots } from './handlers/slots.js';
import { handleHealth } from './handlers/health.js';
import { handlePayNow, handlePayLater } from './handlers/bookings.js';
import { handleConfirm } from './handlers/confirm.js';
import { handleManageInfo } from './handlers/manage-info.js';
import { handleManageCancel } from './handlers/manage-cancel.js';
import { handleManageReschedule } from './handlers/manage-reschedule.js';
import {
  handleGetEvents,
  handleGetEvent,
  handleEventBook,
  handleEventBookWithAccess,
  handleCreateEventReminderSubscription,
} from './handlers/events.js';
import { handleContact } from './handlers/contact.js';
import { handleFrontendObservability } from './handlers/observability.js';
import { handleStripeWebhook } from './handlers/webhook.js';
import { handleJobTrigger } from './handlers/jobs.js';
import {
  handleAdminGetEvents,
  handleAdminGetBookings,
  handleAdminUpdateBooking,
  handleAdminCreateLateAccessLink,
  handleAdminCreateReminderSubscription,
} from './handlers/admin.js';
import {
  handleSimulatePayment,
  handleDevEmails,
  handleDevFailures,
  handleDevBookings,
} from './handlers/dev.js';

import { handlePreflight, getAllowedOrigin, addCors } from './lib/cors.js';
import { ApiError, jsonResponse } from './lib/errors.js';

export interface AppContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
  correlationId: string;
  executionCtx?: ExecutionContext;
}

type Handler = (
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const src = path.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { method, pattern: new RegExp('^' + src + '$'), keys, handler };
}

const ROUTES: Route[] = [
  route('GET', '/api/health', handleHealth),
  route('POST', '/api/observability/frontend', handleFrontendObservability),
  route('GET', '/api/slots', handleGetSlots),

  route('POST', '/api/bookings/pay-now', handlePayNow),
  route('POST', '/api/bookings/pay-later', handlePayLater),
  route('GET', '/api/bookings/confirm', handleConfirm),
  route('GET', '/api/bookings/manage', handleManageInfo),
  route('POST', '/api/bookings/cancel', handleManageCancel),
  route('POST', '/api/bookings/reschedule', handleManageReschedule),

  route('GET', '/api/events', handleGetEvents),
  route('GET', '/api/events/:slug', handleGetEvent),
  route('POST', '/api/events/:slug/book', handleEventBook),
  route('POST', '/api/events/:slug/book-with-access', handleEventBookWithAccess),
  route('POST', '/api/events/reminder-subscriptions', handleCreateEventReminderSubscription),

  route('POST', '/api/contact', handleContact),
  route('GET', '/api/admin/events', handleAdminGetEvents),
  route('GET', '/api/admin/bookings', handleAdminGetBookings),
  route('PATCH', '/api/admin/bookings/:bookingId', handleAdminUpdateBooking),
  route('POST', '/api/admin/events/:eventId/late-access-links', handleAdminCreateLateAccessLink),
  route('POST', '/api/admin/reminder-subscriptions', handleAdminCreateReminderSubscription),
  route('POST', '/api/stripe/webhook', handleStripeWebhook),
  route('POST', '/api/jobs/:name', handleJobTrigger),

  route('POST', '/api/__dev/simulate-payment', handleSimulatePayment),
  route('GET', '/api/__dev/emails', handleDevEmails),
  route('GET', '/api/__dev/failures', handleDevFailures),
  route('GET', '/api/__dev/bookings', handleDevBookings),
];

export async function handleRequest(request: Request, ctx: AppContext): Promise<Response> {
  const url = new URL(request.url);
  const origin = getAllowedOrigin(request, ctx.env.SITE_URL, ctx.env.API_ALLOWED_ORIGINS);
  const requestSizeBytes = headerByteLength(request.headers);

  if (request.method === 'OPTIONS') {
    return origin
      ? handlePreflight(origin)
      : new Response(null, { status: 403 });
  }

  if (!url.pathname.startsWith('/api/')) {
    const res = jsonResponse({ error: 'NOT_FOUND', message: 'Not found' }, 404);
    ctx.logger.logRequest({
      method: request.method,
      url: request.url,
      path: url.pathname,
      statusCode: 404,
      durationMs: 0,
      success: false,
      requestSizeBytes,
    });
    return res;
  }

  ctx.logger.logMilestone('incoming_request_received', {
    method: request.method,
    path: url.pathname,
  });

  for (const r of ROUTES) {
    const match = r.pattern.exec(url.pathname);
    if (!match) continue;
    if (r.method !== '*' && r.method !== request.method) {
      const res = jsonResponse({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }, 405);
      ctx.logger.logRequest({
        method: request.method,
        url: request.url,
        path: url.pathname,
        statusCode: 405,
        durationMs: 0,
        success: false,
        requestSizeBytes,
      });
      return origin ? addCors(res, origin) : res;
    }

    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = match[i + 1] ?? ''; });
    const startedAt = Date.now();

    try {
      const res = await r.handler(request, ctx, params);
      ctx.logger.logRequest({
        method: request.method,
        url: request.url,
        path: url.pathname,
        statusCode: res.status,
        durationMs: Date.now() - startedAt,
        success: res.status < 500,
        requestSizeBytes,
        responseSizeBytes: headerByteLength(res.headers),
      });
      if (res.status < 500) {
        ctx.logger.logMilestone('response_completed', {
          status_code: res.status,
          path: url.pathname,
        });
      }
      return origin ? addCors(res, origin) : res;
    } catch (error) {
      const statusCode = error instanceof ApiError ? error.statusCode : 500;
      if (statusCode >= 500) {
        ctx.logger.captureException({
          eventType: 'uncaught_exception',
          message: 'Route handler failed',
          error,
          context: {
            method: request.method,
            path: url.pathname,
            params,
            status_code: statusCode,
          },
        });
      } else {
        ctx.logger.logWarn({
          eventType: 'handled_exception',
          message: error instanceof Error ? error.message : String(error),
          context: {
            method: request.method,
            path: url.pathname,
            params,
            status_code: statusCode,
          },
        });
      }
      const res = error instanceof ApiError
        ? jsonResponse({ error: error.code, message: error.message }, error.statusCode)
        : jsonResponse({ error: 'INTERNAL_ERROR', message: 'Internal server error' }, 500);
      ctx.logger.logRequest({
        method: request.method,
        url: request.url,
        path: url.pathname,
        statusCode,
        durationMs: Date.now() - startedAt,
        success: statusCode < 500,
        requestSizeBytes,
      });
      return origin ? addCors(res, origin) : res;
    }
  }

  const res = jsonResponse({ error: 'NOT_FOUND', message: 'Not found' }, 404);
  ctx.logger.logRequest({
    method: request.method,
    url: request.url,
    path: url.pathname,
    statusCode: 404,
    durationMs: 0,
    success: false,
    requestSizeBytes,
  });
  return origin ? addCors(res, origin) : res;
}
