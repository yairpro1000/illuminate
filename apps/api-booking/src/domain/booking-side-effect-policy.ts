import {
  isPaymentDueTrackedStatus,
  isPaymentExpiryTrackedStatus,
  isPaymentManualArrangementStatus,
  isPaymentSettledStatus,
} from './payment-status.js';
import type { BookingEffectIntent, BookingSideEffect } from '../types.js';
import type { Providers } from '../providers/index.js';

export const CRON_OWNED_SIDE_EFFECT_INTENTS: ReadonlySet<BookingEffectIntent> = new Set([
  'SEND_PAYMENT_LINK',
  'SEND_PAYMENT_REMINDER',
  'SEND_EVENT_REMINDER',
  'VERIFY_EMAIL_CONFIRMATION',
  'VERIFY_STRIPE_PAYMENT',
]);

export function evaluateSweeperDispatchDecision(
  effect: Pick<BookingSideEffect, 'effect_intent' | 'status' | 'created_at' | 'updated_at'>,
  lastAttempt: { attempt_num: number } | null,
): {
  shouldDispatch: boolean;
  branchTaken: string;
  denyReason: string | null;
} {
  if (effect.status === 'FAILED') {
    return {
      shouldDispatch: true,
      branchTaken: 'dispatch_failed_effect_retry',
      denyReason: null,
    };
  }

  if (CRON_OWNED_SIDE_EFFECT_INTENTS.has(effect.effect_intent)) {
    return {
      shouldDispatch: true,
      branchTaken: 'dispatch_cron_owned_effect',
      denyReason: null,
    };
  }

  if (lastAttempt) {
    return {
      shouldDispatch: true,
      branchTaken: 'dispatch_pending_effect_with_attempt_history',
      denyReason: null,
    };
  }

  const wasPreviouslyTouched = new Date(effect.updated_at).getTime() > new Date(effect.created_at).getTime();
  if (wasPreviouslyTouched) {
    return {
      shouldDispatch: true,
      branchTaken: 'dispatch_stale_recovered_pending_effect',
      denyReason: null,
    };
  }

  return {
    shouldDispatch: false,
    branchTaken: 'skip_pending_non_cron_first_attempt',
    denyReason: 'non_cron_side_effect_must_execute_realtime',
  };
}

export function sideEffectTiming(
  effect: BookingSideEffect & { booking_id: string },
  nowIso: string,
): 'run' | 'wait' | 'expired' {
  if (!effect.expires_at) return 'run';

  const nowMs = new Date(nowIso).getTime();
  const expiresMs = new Date(effect.expires_at).getTime();
  const nowAfterExpiry = nowMs >= expiresMs;

  switch (effect.effect_intent) {
    case 'SEND_PAYMENT_LINK':
    case 'SEND_PAYMENT_REMINDER':
    case 'SEND_EVENT_REMINDER':
    case 'VERIFY_EMAIL_CONFIRMATION':
    case 'VERIFY_STRIPE_PAYMENT':
    case 'RESERVE_CALENDAR_SLOT':
    case 'UPDATE_CALENDAR_SLOT':
    case 'CANCEL_CALENDAR_SLOT':
      return nowAfterExpiry ? 'run' : 'wait';
    default:
      return nowAfterExpiry ? 'expired' : 'run';
  }
}

export async function evaluateSideEffectRelevance(
  effect: BookingSideEffect & { booking_id: string },
  repository: Pick<Providers['repository'], 'getPaymentByBookingId'>,
): Promise<{
  shouldProcess: boolean;
  branchTaken: string;
  denyReason: string | null;
  context: Record<string, unknown>;
}> {
  switch (effect.effect_intent) {
    case 'SEND_PAYMENT_LINK': {
      const payment = await repository.getPaymentByBookingId(effect.booking_id);
      const paymentStatus = payment?.status ?? null;
      const alreadySettled = isPaymentSettledStatus(paymentStatus);
      const manualArrangement = isPaymentManualArrangementStatus(paymentStatus);
      return {
        shouldProcess: !alreadySettled && !manualArrangement,
        branchTaken: alreadySettled
          ? 'deny_irrelevant_payment_link_already_settled'
          : manualArrangement
            ? 'deny_irrelevant_payment_link_manual_arrangement'
            : 'allow_payment_link_effect',
        denyReason: alreadySettled
          ? 'payment_already_settled'
          : manualArrangement
            ? 'manual_payment_arrangement_active'
            : null,
        context: {
          payment_status: paymentStatus,
          has_payment_url: Boolean(payment?.invoice_url ?? payment?.checkout_url),
        },
      };
    }
    case 'SEND_PAYMENT_REMINDER': {
      const payment = await repository.getPaymentByBookingId(effect.booking_id);
      const paymentStatus = payment?.status ?? null;
      const dueTracked = isPaymentDueTrackedStatus(paymentStatus);
      return {
        shouldProcess: dueTracked,
        branchTaken: dueTracked
          ? 'allow_due_tracked_payment_reminder_effect'
          : isPaymentManualArrangementStatus(paymentStatus)
            ? 'deny_irrelevant_send_payment_reminder_manual_arrangement'
            : isPaymentSettledStatus(paymentStatus)
              ? 'deny_irrelevant_send_payment_reminder_already_settled'
              : 'deny_irrelevant_send_payment_reminder_status_not_due_tracked',
        denyReason: dueTracked
          ? null
          : isPaymentManualArrangementStatus(paymentStatus)
            ? 'manual_payment_arrangement_active'
            : isPaymentSettledStatus(paymentStatus)
              ? 'payment_already_settled'
              : 'payment_status_not_due_tracked',
        context: {
          payment_status: paymentStatus,
        },
      };
    }
    case 'VERIFY_STRIPE_PAYMENT': {
      const payment = await repository.getPaymentByBookingId(effect.booking_id);
      const paymentStatus = payment?.status ?? null;
      const expiryTracked = isPaymentExpiryTrackedStatus(paymentStatus);
      return {
        shouldProcess: expiryTracked,
        branchTaken: expiryTracked
          ? 'allow_expiry_tracked_payment_verification_effect'
          : isPaymentManualArrangementStatus(paymentStatus)
            ? 'deny_irrelevant_verify_stripe_payment_manual_arrangement'
            : isPaymentSettledStatus(paymentStatus)
              ? 'deny_irrelevant_verify_stripe_payment_already_settled'
              : 'deny_irrelevant_verify_stripe_payment_status_not_expiry_tracked',
        denyReason: expiryTracked
          ? null
          : isPaymentManualArrangementStatus(paymentStatus)
            ? 'manual_payment_arrangement_active'
            : isPaymentSettledStatus(paymentStatus)
              ? 'payment_already_settled'
              : 'payment_status_not_expiry_tracked',
        context: {
          payment_status: paymentStatus,
        },
      };
    }
    default:
      return {
        shouldProcess: true,
        branchTaken: 'allow_non_guarded_effect',
        denyReason: null,
        context: {},
      };
  }
}
