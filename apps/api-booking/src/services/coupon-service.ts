import type { Logger } from '../lib/logger.js';
import type { IRepository } from '../providers/repository/interface.js';
import type { Coupon } from '../types.js';
import { badRequest } from '../lib/errors.js';
import { applyPercentDiscount, roundCurrencyAmount } from '../domain/pricing.js';

export function normalizeCouponCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toUpperCase();
  return normalized ? normalized : null;
}

export async function resolveCouponByCode(
  rawCode: unknown,
  repository: IRepository,
  logger?: Logger,
  context: Record<string, unknown> = {},
): Promise<Coupon | null> {
  const normalizedCode = normalizeCouponCode(rawCode);
  logger?.logInfo?.({
    source: 'backend',
    eventType: 'coupon_resolution_started',
    message: 'Resolving coupon code',
    context: {
      ...context,
      has_coupon_code: Boolean(normalizedCode),
      coupon_code_normalized: normalizedCode,
      branch_taken: normalizedCode ? 'lookup_coupon_code' : 'skip_coupon_lookup',
      deny_reason: normalizedCode ? null : 'coupon_code_missing',
    },
  });

  if (!normalizedCode) return null;

  const coupon = await repository.getCouponByCode(normalizedCode);
  logger?.logInfo?.({
    source: 'backend',
    eventType: 'coupon_resolution_completed',
    message: 'Completed coupon code resolution',
    context: {
      ...context,
      coupon_code_normalized: normalizedCode,
      coupon_found: Boolean(coupon),
      discount_percent: coupon?.discount_percent ?? null,
      branch_taken: coupon ? 'coupon_found' : 'deny_coupon_not_found',
      deny_reason: coupon ? null : 'coupon_not_found',
    },
  });

  if (!coupon) {
    throw badRequest('Invalid coupon code', 'INVALID_COUPON');
  }

  return {
    code: coupon.code,
    discount_percent: roundCurrencyAmount(coupon.discount_percent),
  };
}

export function applyCouponToPrice(
  basePrice: number,
  coupon: Coupon | null,
): { basePrice: number; finalPrice: number; couponCode: string | null; discountPercent: number } {
  const roundedBasePrice = roundCurrencyAmount(basePrice);
  if (!coupon) {
    return {
      basePrice: roundedBasePrice,
      finalPrice: roundedBasePrice,
      couponCode: null,
      discountPercent: 0,
    };
  }

  return {
    basePrice: roundedBasePrice,
    finalPrice: applyPercentDiscount(roundedBasePrice, coupon.discount_percent),
    couponCode: coupon.code,
    discountPercent: roundCurrencyAmount(coupon.discount_percent),
  };
}
