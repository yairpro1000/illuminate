import { badRequest } from '../lib/errors.js';

export const CHF_TO_ILS_DISPLAY_RATE = 4;

export function roundCurrencyAmount(amount: number): number {
  return Number(amount.toFixed(2));
}

export function applyPercentDiscount(basePrice: number, discountPercent: number): number {
  if (!Number.isFinite(basePrice) || basePrice < 0) {
    throw badRequest('base_price_invalid', 'INVALID_PRICE');
  }
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw badRequest('discount_percent_invalid', 'INVALID_PRICE');
  }
  const discountFactor = 1 - (discountPercent / 100);
  return roundCurrencyAmount(basePrice * discountFactor);
}
