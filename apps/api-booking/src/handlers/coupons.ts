import type { AppContext } from '../router.js';
import { badRequest, notFound, ok } from '../lib/errors.js';
import { normalizeCouponCode, resolveCouponByCode } from '../services/coupon-service.js';

// POST /api/coupons/validate
export async function handleValidateCoupon(request: Request, ctx: AppContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  ctx.logger.logInfo?.({
    source: 'backend',
    eventType: 'coupon_validation_request_started',
    message: 'Started coupon validation request',
    context: {
      path,
      request_id: ctx.requestId,
      branch_taken: 'parse_coupon_validation_payload',
    },
  });

  try {
    const body = await request.json() as Record<string, unknown>;
    const normalizedCode = normalizeCouponCode(body.code);
    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'coupon_validation_request_decision',
      message: 'Evaluated coupon validation request payload',
      context: {
        path,
        request_id: ctx.requestId,
        requested_coupon_code: normalizedCode,
        branch_taken: normalizedCode ? 'lookup_coupon_validation' : 'deny_coupon_code_missing',
        deny_reason: normalizedCode ? null : 'coupon_code_missing',
      },
    });

    if (!normalizedCode) {
      throw badRequest('Coupon code is required');
    }

    const coupon = await resolveCouponByCode(normalizedCode, ctx.providers.repository, ctx.logger, {
      path,
      request_id: ctx.requestId,
      validation_source: 'public_coupon_validation_endpoint',
    });

    ctx.logger.logInfo?.({
      source: 'backend',
      eventType: 'coupon_validation_request_completed',
      message: 'Coupon validation request completed',
      context: {
        path,
        request_id: ctx.requestId,
        requested_coupon_code: normalizedCode,
        discount_percent: coupon?.discount_percent ?? null,
        branch_taken: 'return_valid_coupon',
        deny_reason: null,
      },
    });

    return ok({
      coupon: {
        code: coupon!.code,
        discount_percent: coupon!.discount_percent,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === 'INVALID_COUPON') {
      ctx.logger.logWarn?.({
        source: 'backend',
        eventType: 'coupon_validation_request_failed',
        message: err instanceof Error ? err.message : String(err),
        context: {
          path,
          request_id: ctx.requestId,
          status_code: 404,
          branch_taken: 'deny_coupon_not_found',
          deny_reason: 'coupon_not_found',
        },
      });
      throw notFound('Coupon code is invalid');
    }
    throw err;
  }
}
