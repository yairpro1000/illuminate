import type { PaymentStatus } from '../types.js';

export function isPaymentSettledStatus(status: PaymentStatus | null | undefined): boolean {
  return status === 'SUCCEEDED' || status === 'REFUNDED';
}

export function isPaymentManualArrangementStatus(status: PaymentStatus | null | undefined): boolean {
  return status === 'CASH_OK';
}

export function isPaymentDueTrackedStatus(status: PaymentStatus | null | undefined): boolean {
  return status === 'PENDING' || status === 'INVOICE_SENT';
}

export function isPaymentContinuableOnline(status: PaymentStatus | null | undefined): boolean {
  return status === 'PENDING'
    || status === 'INVOICE_SENT'
    || status === 'FAILED'
    || status === 'CASH_OK';
}
