import type { PaymentStatus } from '../types.js';

export function isPaymentSettledStatus(status: PaymentStatus | null | undefined): boolean {
  return status === 'SUCCEEDED' || status === 'REFUNDED';
}

export function isPaymentManualArrangementStatus(status: PaymentStatus | null | undefined): boolean {
  return status === 'CASH_OK';
}

export function isPaymentContinuableOnline(status: PaymentStatus | null | undefined): boolean {
  return status === 'PENDING' || status === 'FAILED';
}

