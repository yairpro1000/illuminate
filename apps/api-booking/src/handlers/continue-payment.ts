import type { AppContext } from '../router.js';
import { ApiError, badRequest, ok } from '../lib/errors.js';
import { getContinuePaymentActionInfo } from '../services/booking-service.js';

// GET /api/bookings/continue-payment?token=<raw>
export async function handleContinuePayment(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const adminToken = url.searchParams.get('admin_token');
    if (!token) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'continue_payment_token_gate_decision',
        message: 'Continue-payment request denied because token was missing',
        context: {
          path,
          branch_taken: 'deny_missing_token',
          deny_reason: 'token_missing',
        },
      });
      throw badRequest('token is required');
    }

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'continue_payment_request_started',
      message: 'Started continue-payment request handling',
      context: {
        path,
        request_id: ctx.requestId,
        branch_taken: 'evaluate_booking_and_payment_status',
      },
    });

    const action = await getContinuePaymentActionInfo(token, adminToken, {
      providers: ctx.providers,
      env: ctx.env,
      logger: ctx.logger,
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      operation: ctx.operation,
    });

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'continue_payment_request_decision',
      message: 'Evaluated continue-payment eligibility',
      context: {
        path,
        request_id: ctx.requestId,
        booking_id: action.booking.id,
        booking_status: action.booking.current_status,
        payment_status: action.paymentStatus,
        payment_due_at: action.paymentDueAt,
        has_checkout_url: Boolean(action.checkoutUrl),
        has_manage_url: Boolean(action.manageUrl),
        can_continue_to_checkout: action.canContinueToCheckout,
        branch_taken: action.branchTaken,
        deny_reason: action.denyReason,
      },
    });

    return ok({
      booking_id: action.booking.id,
      status: action.booking.current_status,
      payment_status: action.paymentStatus,
      payment_due_at: action.paymentDueAt,
      source: action.booking.event_id ? 'event' : 'session',
      action: action.canContinueToCheckout ? 'checkout' : 'manage',
      action_url: action.canContinueToCheckout ? action.checkoutUrl : action.manageUrl,
      manage_url: action.manageUrl,
      checkout_url: action.checkoutUrl,
    });
  } catch (err) {
    const statusCode = err instanceof ApiError ? err.statusCode : 500;
    if (err instanceof ApiError) {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'continue_payment_request_failed',
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
        message: 'Continue-payment request failed unexpectedly',
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
