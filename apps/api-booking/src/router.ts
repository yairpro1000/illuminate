import type { Env } from './env.js';
import type { Providers } from './providers/index.js';
import type { Logger } from './lib/logger.js';
import { headerByteLength } from '../../shared/observability/backend.js';

import { handleGetSlots } from './handlers/slots.js';
import { handleHealth } from './handlers/health.js';
import { handleGetPublicConfig } from './handlers/config.js';
import { handleValidateCoupon } from './handlers/coupons.js';
import { handlePayNow, handlePayLater } from './handlers/bookings.js';
import { handleConfirm } from './handlers/confirm.js';
import { handleContinuePayment } from './handlers/continue-payment.js';
import { handlePaymentStatus } from './handlers/payment-status.js';
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
import { handleTurnstileVerify } from './handlers/turnstile.js';
import { handleAdminUploadImage } from './handlers/upload.js';
import { handleFrontendObservability } from './handlers/observability.js';
import { handleStripeWebhook } from './handlers/webhook.js';
import { handleJobTrigger } from './handlers/jobs.js';
import {
  handleAdminGetEvents,
  handleAdminGetAllEvents,
  handleAdminUpdateEvent,
  handleAdminGetBookings,
  handleAdminGetContactMessages,
  handleAdminUpdateBooking,
  handleAdminSettleBookingPayment,
  handleAdminCreateBookingManageLink,
  handleAdminCreateClientManageLink,
  handleAdminCreateLateAccessLink,
  handleAdminCreateReminderSubscription,
  handleAdminGetConfig,
  handleAdminPatchConfig,
} from './handlers/admin.js';
import {
  handleSimulatePayment,
  handleDevEmails,
  handleDevEmailDetail,
  handleDevEmailHtml,
  handleDevFailures,
  handleDevBookings,
  handleTestBookingArtifacts,
  handleTestBookingExpire,
  handleTestBookingMutate,
  handleTestBookingsList,
  handleTestBookingsCleanup,
} from './handlers/dev.js';

import { handlePreflight, getAllowedOrigin, addCors } from './lib/cors.js';
import { ApiError, errorBody, jsonResponse } from './lib/errors.js';
import { type OperationContext } from './lib/execution.js';
import {
  recordExceptionLog,
  wrapProvidersForOperation,
} from './lib/technical-observability.js';
import {
  handleGetSessionTypes,
  handleAdminGetSessionTypes,
  handleAdminCreateSessionType,
  handleAdminUpdateSessionType,
} from './handlers/session-types.js';

export interface AppContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
  correlationId: string;
  operation: OperationContext;
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
  executionLayer: 'default' | 'booking';
}

function route(method: string, path: string, handler: Handler, executionLayer: Route['executionLayer'] = 'default'): Route {
  const keys: string[] = [];
  const src = path.replace(/:([^/]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { method, pattern: new RegExp('^' + src + '$'), keys, handler, executionLayer };
}

const ROUTES: Route[] = [
  route('GET', '/api/health', handleHealth),
  route('GET', '/api/config', handleGetPublicConfig),
  route('POST', '/api/coupons/validate', handleValidateCoupon),
  route('POST', '/api/observability/frontend', handleFrontendObservability),
  route('GET', '/api/slots', handleGetSlots, 'booking'),

  route('POST', '/api/bookings/pay-now', handlePayNow, 'booking'),
  route('POST', '/api/bookings/pay-later', handlePayLater, 'booking'),
  route('GET', '/api/bookings/confirm', handleConfirm, 'booking'),
  route('GET', '/api/bookings/continue-payment', handleContinuePayment, 'booking'),
  route('GET', '/api/bookings/payment-status', handlePaymentStatus, 'booking'),
  route('GET', '/api/bookings/manage', handleManageInfo, 'booking'),
  route('POST', '/api/bookings/cancel', handleManageCancel, 'booking'),
  route('POST', '/api/bookings/reschedule', handleManageReschedule, 'booking'),

  route('GET', '/api/events', handleGetEvents),
  route('GET', '/api/events/:slug', handleGetEvent),
  route('POST', '/api/events/:slug/book', handleEventBook, 'booking'),
  route('POST', '/api/events/:slug/book-with-access', handleEventBookWithAccess, 'booking'),
  route('POST', '/api/events/reminder-subscriptions', handleCreateEventReminderSubscription),

  route('GET', '/api/session-types', handleGetSessionTypes),

  route('POST', '/api/contact', handleContact),
  route('POST', '/api/antibot/turnstile/verify', handleTurnstileVerify),
  route('GET', '/api/admin/events', handleAdminGetEvents),
  route('GET', '/api/admin/events/all', handleAdminGetAllEvents),
  route('PATCH', '/api/admin/events/:eventId', handleAdminUpdateEvent),
  route('GET', '/api/admin/bookings', handleAdminGetBookings),
  route('GET', '/api/admin/contact-messages', handleAdminGetContactMessages),
  route('PATCH', '/api/admin/bookings/:bookingId', handleAdminUpdateBooking),
  route('POST', '/api/admin/bookings/:bookingId', handleAdminUpdateBooking),
  route('POST', '/api/admin/bookings/:bookingId/payment-settled', handleAdminSettleBookingPayment),
  route('POST', '/api/admin/bookings/:bookingId/manage-link', handleAdminCreateBookingManageLink),
  route('POST', '/api/admin/bookings/:bookingId/client-manage-link', handleAdminCreateClientManageLink),
  route('POST', '/api/admin/events/:eventId/late-access-links', handleAdminCreateLateAccessLink),
  route('POST', '/api/admin/reminder-subscriptions', handleAdminCreateReminderSubscription),
  route('GET',  '/api/admin/config', handleAdminGetConfig),
  route('PATCH', '/api/admin/config', handleAdminPatchConfig),
  route('POST', '/api/admin/config', handleAdminPatchConfig),
  route('POST', '/api/admin/upload-image', handleAdminUploadImage),
  route('GET', '/api/admin/session-types', handleAdminGetSessionTypes),
  route('POST', '/api/admin/session-types', handleAdminCreateSessionType),
  route('PATCH', '/api/admin/session-types/:id', handleAdminUpdateSessionType),
  route('POST', '/api/stripe/webhook', handleStripeWebhook, 'booking'),
  route('POST', '/api/jobs/:name', handleJobTrigger, 'booking'),

  route('POST', '/api/__dev/simulate-payment', handleSimulatePayment),
  route('GET', '/api/__dev/emails', handleDevEmails),
  route('GET', '/api/__dev/emails/:emailId', handleDevEmailDetail),
  route('GET', '/api/__dev/emails/:emailId/html', handleDevEmailHtml),
  route('GET', '/api/__dev/failures', handleDevFailures),
  route('GET', '/api/__dev/bookings', handleDevBookings),
  route('GET', '/api/__test/booking-artifacts', handleTestBookingArtifacts),
  route('POST', '/api/__test/bookings/expire', handleTestBookingExpire),
  route('POST', '/api/__test/bookings/mutate', handleTestBookingMutate),
  route('GET', '/api/__test/bookings', handleTestBookingsList),
  route('POST', '/api/__test/bookings/cleanup', handleTestBookingsCleanup),
];

export async function handleRequest(request: Request, ctx: AppContext): Promise<Response> {
  const url = new URL(request.url);
  const isAdminEventsPath = url.pathname === '/api/admin/events';
  const isFrontendObservabilityPath = url.pathname === '/api/observability/frontend';
  const devMode = !!ctx.env.ADMIN_DEV_EMAIL;
  const origin = getAllowedOrigin(request, ctx.env.SITE_URL, ctx.env.API_ALLOWED_ORIGINS, !!ctx.env.ADMIN_DEV_EMAIL);
  const requestSizeBytes = headerByteLength(request.headers);
  if (isAdminEventsPath) {
    console.log('[admin-events-debug] ingress', JSON.stringify({
      method: request.method,
      path: url.pathname,
      origin: request.headers.get('Origin'),
      origin_allowed: !!origin,
      origin_allowed_value: origin,
      admin_auth_disabled: /^(1|true|yes|on)$/i.test(String(ctx.env.ADMIN_AUTH_DISABLED ?? '').trim()),
      user_agent: request.headers.get('user-agent'),
      cf_ray: request.headers.get('cf-ray'),
    }));
  }

  if (request.method === 'OPTIONS') {
    const requestedHeaders = String(request.headers.get('Access-Control-Request-Headers') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    ctx.logger.logInfo({
      source: 'worker',
      eventType: 'cors_preflight_evaluation_started',
      message: 'Evaluating CORS preflight request',
      context: {
        method: request.method,
        path: url.pathname,
        request_origin: request.headers.get('Origin'),
        requested_method: request.headers.get('Access-Control-Request-Method'),
        requested_headers: requestedHeaders,
        site_url: ctx.env.SITE_URL,
        configured_origins: ctx.env.API_ALLOWED_ORIGINS || null,
        dev_mode: devMode,
        branch_taken: 'evaluate_cors_preflight',
      },
    });
    const preflightRes = origin
      ? handlePreflight(origin)
      : new Response(null, {
        status: 403,
        headers: { Vary: 'Origin' },
      });
    if (origin) {
      ctx.logger.logInfo({
        source: 'worker',
        eventType: 'cors_preflight_evaluation_completed',
        message: 'Allowed CORS preflight request',
        context: {
          method: request.method,
          path: url.pathname,
          request_origin: request.headers.get('Origin'),
          allowed_origin: origin,
          requested_method: request.headers.get('Access-Control-Request-Method'),
          requested_headers: requestedHeaders,
          status_code: preflightRes.status,
          branch_taken: 'allow_cors_preflight',
          deny_reason: null,
          dev_mode: devMode,
        },
      });
    } else {
      ctx.logger.logWarn({
        source: 'worker',
        eventType: 'cors_preflight_evaluation_completed',
        message: 'Rejected CORS preflight request',
        context: {
          method: request.method,
          path: url.pathname,
          request_origin: request.headers.get('Origin'),
          allowed_origin: null,
          requested_method: request.headers.get('Access-Control-Request-Method'),
          requested_headers: requestedHeaders,
          status_code: preflightRes.status,
          branch_taken: 'deny_cors_preflight_origin_not_allowed',
          deny_reason: 'origin_not_allowed',
          dev_mode: devMode,
        },
      });
    }
    if (isAdminEventsPath) {
      console.log('[admin-events-debug] preflight', JSON.stringify({
        status: preflightRes.status,
        has_cors_header: !!preflightRes.headers.get('Access-Control-Allow-Origin'),
        cors_origin: preflightRes.headers.get('Access-Control-Allow-Origin'),
      }));
    }
    return preflightRes;
  }

  if (!url.pathname.startsWith('/api/')) {
    const res = jsonResponse({ error: 'NOT_FOUND', message: 'Not found' }, 404);
    ctx.logger.logRequest({
      method: request.method,
      url: request.url,
      path: url.pathname,
      statusCode: 404,
      durationMs: 0,
      success: true,
      requestSizeBytes,
    });
    const finalRes = origin ? addCors(res, origin) : res;
    if (isAdminEventsPath) {
      console.log('[admin-events-debug] non_api', JSON.stringify({
        status: finalRes.status,
        has_cors_header: !!finalRes.headers.get('Access-Control-Allow-Origin'),
        cors_origin: finalRes.headers.get('Access-Control-Allow-Origin'),
      }));
    }
    return finalRes;
  }

  if (!isFrontendObservabilityPath) {
    ctx.logger.logMilestone('incoming_request_received', {
      method: request.method,
      path: url.pathname,
    });
  }

  let patternMatched = false;
  for (const r of ROUTES) {
    const match = r.pattern.exec(url.pathname);
    if (!match) continue;
    if (r.method !== '*' && r.method !== request.method) {
      patternMatched = true;
      continue; // keep scanning — another route may match with the right method
    }

    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = match[i + 1] ?? ''; });
    const startedAt = Date.now();

    try {
      const res = await executeObservedRoute(request, ctx, params, r.handler, r.executionLayer);
      if (!isFrontendObservabilityPath || res.status >= 400) {
        ctx.logger.logRequest?.({
          method: request.method,
          url: request.url,
          path: url.pathname,
          statusCode: res.status,
          durationMs: Date.now() - startedAt,
          success: res.status < 500,
          requestSizeBytes,
          responseSizeBytes: headerByteLength(res.headers),
        });
      }
      if (res.status < 500 && !isFrontendObservabilityPath) {
        ctx.logger.logMilestone?.('response_completed', {
          status_code: res.status,
          path: url.pathname,
        });
      }
      const finalRes = origin ? addCors(res, origin) : res;
      if (isAdminEventsPath) {
        console.log('[admin-events-debug] matched_route_response', JSON.stringify({
          status: finalRes.status,
          handler_status: res.status,
          has_cors_header: !!finalRes.headers.get('Access-Control-Allow-Origin'),
          cors_origin: finalRes.headers.get('Access-Control-Allow-Origin'),
        }));
      }
      return finalRes;
    } catch (error) {
      const statusCode = error instanceof ApiError ? error.statusCode : 500;
      if (statusCode >= 500) {
        ctx.logger.captureException?.({
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
        ctx.logger.logWarn?.({
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
        ? jsonResponse(errorBody(error, ctx.requestId), error.statusCode)
        : jsonResponse(errorBody(error, ctx.requestId), 500);
      ctx.logger.logRequest?.({
        method: request.method,
        url: request.url,
        path: url.pathname,
        statusCode,
        durationMs: Date.now() - startedAt,
        success: statusCode < 500,
        requestSizeBytes,
      });
      const finalRes = origin ? addCors(res, origin) : res;
      if (isAdminEventsPath) {
        console.log('[admin-events-debug] matched_route_error', JSON.stringify({
          status: finalRes.status,
          error_status: statusCode,
          error_code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
          error_message: error instanceof Error ? error.message : String(error),
          has_cors_header: !!finalRes.headers.get('Access-Control-Allow-Origin'),
          cors_origin: finalRes.headers.get('Access-Control-Allow-Origin'),
        }));
      }
      return finalRes;
    }
  }

  const statusCode = patternMatched ? 405 : 404;
  const res = patternMatched
    ? jsonResponse({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' }, 405)
    : jsonResponse({ error: 'NOT_FOUND', message: 'Not found' }, 404);
  ctx.logger.logRequest({
    method: request.method,
    url: request.url,
    path: url.pathname,
    statusCode,
    durationMs: 0,
    success: statusCode < 500,
    requestSizeBytes,
  });
  const finalRes = origin ? addCors(res, origin) : res;
  if (isAdminEventsPath) {
    console.log('[admin-events-debug] unmatched_route', JSON.stringify({
      status: finalRes.status,
      has_cors_header: !!finalRes.headers.get('Access-Control-Allow-Origin'),
      cors_origin: finalRes.headers.get('Access-Control-Allow-Origin'),
    }));
  }
  return finalRes;
}

async function executeObservedRoute(
  request: Request,
  ctx: AppContext,
  params: Record<string, string>,
  handler: Handler,
  executionLayer: Route['executionLayer'],
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const isBookingRoute = executionLayer === 'booking';
  const shouldSuppressSuccessLifecycleLogs = path === '/api/observability/frontend';
  const routeCtx: AppContext = {
    ...ctx,
    operation: ctx.operation,
  };
  routeCtx.providers = wrapProvidersForOperation(routeCtx.providers, routeCtx.env, routeCtx.logger, routeCtx.operation, {
    emailPreviewContext: {
      emailMode: routeCtx.env.EMAIL_MODE,
      apiOrigin: new URL(request.url).origin,
      request,
    },
  });

  if (!shouldSuppressSuccessLifecycleLogs) {
    routeCtx.logger.logInfo({
      source: 'worker',
      eventType: isBookingRoute ? 'booking_route_execution_started' : 'route_execution_started',
      message: isBookingRoute
        ? 'Executing booking route through shared inbound wrapper'
        : 'Executing route through shared inbound wrapper',
      context: {
        method: request.method,
        path,
        params,
        branch_taken: isBookingRoute ? 'execute_booking_route_wrapper' : 'execute_route_wrapper',
        execution_layer: executionLayer,
      },
    });
  }

  try {
    const response = await handler(request, routeCtx, params);
    if (!shouldSuppressSuccessLifecycleLogs) {
      routeCtx.logger.logInfo({
        source: 'worker',
        eventType: isBookingRoute ? 'booking_route_execution_completed' : 'route_execution_completed',
        message: isBookingRoute
          ? 'Booking route completed through shared inbound wrapper'
          : 'Route completed through shared inbound wrapper',
        context: {
          method: request.method,
          path,
          status_code: response.status,
          branch_taken: isBookingRoute ? 'return_booking_route_response' : 'return_route_response',
          execution_layer: executionLayer,
        },
      });
    }
    return response;
  } catch (error) {
    const statusCode = error instanceof ApiError ? error.statusCode : 500;
    ctx.operation.latestInboundErrorCode = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
    ctx.operation.latestInboundErrorMessage = error instanceof Error ? error.message : String(error);
    if (statusCode >= 500) {
      routeCtx.logger.captureException({
        eventType: isBookingRoute ? 'booking_route_execution_failed' : 'route_execution_failed',
        message: isBookingRoute
          ? 'Booking route failed in shared inbound wrapper'
          : 'Route failed in shared inbound wrapper',
        error,
        context: {
          method: request.method,
          path,
          params,
          status_code: statusCode,
          branch_taken: 'unexpected_exception',
          execution_layer: executionLayer,
        },
      });
    } else {
      routeCtx.logger.logWarn({
        source: 'worker',
        eventType: isBookingRoute ? 'booking_route_execution_failed' : 'route_execution_failed',
        message: error instanceof Error ? error.message : String(error),
        context: {
          method: request.method,
          path,
          params,
          status_code: statusCode,
          error_code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
          branch_taken: 'handled_api_error',
          deny_reason: error instanceof ApiError ? error.code : 'unexpected_error',
          execution_layer: executionLayer,
        },
      });
    }

    if (statusCode >= 500) {
      await recordExceptionLog(routeCtx.env, routeCtx.operation, error, {
        method: request.method,
        path,
        params,
        status_code: statusCode,
      }, error instanceof ApiError ? error.code : 'INTERNAL_ERROR');
    }

    return jsonResponse(errorBody(error, routeCtx.requestId), statusCode);
  }
}
