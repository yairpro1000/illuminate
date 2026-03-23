import { appendBookingEventWithEffects } from './booking-transition.js';
import { getBookingPolicyConfig } from '../domain/booking-effect-policy.js';
import {
  isPaymentExpiryTrackedStatus,
  isPaymentManualArrangementStatus,
  isPaymentSettledStatus,
} from '../domain/payment-status.js';
import type { Booking, BookingEffectIntent, BookingEventRecord, BookingEventType } from '../types.js';
import type {
  BookingSideEffectExecutorInput,
  BookingSideEffectExecutorResult,
} from './booking-event-workflow.js';
import type { BookingContext } from './booking-service.js';
import type { CancellationRefundExecutionResult } from './refund-service.js';

type EffectHandler = (input: BookingSideEffectExecutorInput) => Promise<BookingSideEffectExecutorResult>;

interface ExecutorDeps {
  buildConfirmUrl: (siteUrl: string, rawToken: string) => string;
  buildContinuePaymentUrl: (siteUrl: string, booking: Booking) => string;
  buildManageUrl: (siteUrl: string, booking: Booking) => Promise<string>;
  bookingSiteUrl: (ctx: Pick<BookingContext, 'siteUrl' | 'env'>) => string;
  buildStartNewBookingUrl: (siteUrl: string, booking: Booking) => string;
  sendEmailConfirmation: (booking: Booking, confirmUrl: string, ctx: BookingContext) => Promise<void>;
  sendBookingCancellationConfirmation: (booking: Booking, ctx: BookingContext) => Promise<void>;
  sendBookingFinalConfirmation: (booking: Booking, ctx: BookingContext) => Promise<void>;
  send24hBookingReminder: (booking: Booking, ctx: BookingContext) => Promise<void>;
  sendRefundConfirmationEmailForBooking: (
    booking: Booking,
    effect: BookingSideEffectExecutorInput['effect'],
    ctx: BookingContext,
  ) => Promise<void>;
  retryCalendarSyncForBooking: (
    booking: Booking,
    operation: 'create' | 'update' | 'delete',
    ctx: BookingContext,
  ) => Promise<{
    booking: Booking;
    calendarSynced: boolean;
    failureReason: string | null;
    retryableFailure: boolean;
  }>;
  ensureCheckoutForBooking: (
    booking: Booking,
    ctx: BookingContext,
  ) => Promise<{ checkoutUrl: string | null; expiresAt: string | null }>;
  initiateAutomaticCancellationRefund: (
    booking: Booking,
    ctx: BookingContext,
  ) => Promise<CancellationRefundExecutionResult>;
  completeEmailVerificationWithinEvent: (
    eventId: string,
    booking: Booking,
    ctx: BookingContext,
  ) => Promise<{ booking: Booking; nextSideEffects: BookingSideEffectExecutorInput['effect'][] }>;
  expireBooking: (booking: Booking, ctx: BookingContext) => Promise<Booking>;
  runImmediateBookingEventWorkflow: (input: {
    transitionEvent: BookingEventRecord;
    transitionEventType: BookingEventType;
    sourceOperation: string;
    bookingBeforeTransition: Booking;
    bookingAfterTransition: Booking;
    transitionSideEffects: BookingSideEffectExecutorInput['effect'][];
  }, ctx: BookingContext) => Promise<{ booking: Booking }>;
}

function withCalendarResult(result: {
  booking: Booking;
  calendarSynced: boolean;
  failureReason: string | null;
  retryableFailure: boolean;
}): BookingSideEffectExecutorResult {
  if (result.calendarSynced) {
    return { booking: result.booking };
  }
  return {
    booking: result.booking,
    handledFailure: {
      errorMessage: result.failureReason ?? 'calendar_sync_failed',
      enableCalendarBackoff: result.retryableFailure,
    },
  };
}

function makeHandlerMap(deps: ExecutorDeps): Record<BookingEffectIntent, EffectHandler> {
  return {
    SEND_BOOKING_CONFIRMATION_REQUEST: async ({ booking, event, ctx }) => {
      const confirmToken = typeof event.payload?.['confirm_token'] === 'string'
        ? event.payload['confirm_token'] as string
        : null;
      if (!confirmToken) {
        const viaLateAccess = event.payload?.['via_late_access'] === true;
        if (viaLateAccess) {
          ctx.logger.logInfo?.({
            source: 'backend',
            eventType: 'realtime_side_effect_noop',
            message: 'Skipped confirmation email for late-access booking',
            context: {
              booking_id: booking.id,
              transition_event_type: event.event_type,
              side_effect_id: event.id,
              side_effect_intent: 'SEND_BOOKING_CONFIRMATION_REQUEST',
              branch_taken: 'skip_confirmation_email_late_access_flow',
              deny_reason: 'late_access_booking_has_no_confirm_token',
            },
          });
          return { booking };
        }
        throw new Error('confirm_token_missing');
      }
      const confirmUrl = deps.buildConfirmUrl(deps.bookingSiteUrl(ctx), confirmToken);
      await deps.sendEmailConfirmation(booking, confirmUrl, ctx);
      return { booking };
    },
    SEND_PAYMENT_LINK: async ({ booking, ctx }) => {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      const payUrl = payment?.invoice_url ?? payment?.checkout_url ?? deps.buildContinuePaymentUrl(deps.bookingSiteUrl(ctx), booking);
      if (!payUrl) throw new Error('checkout_url_missing');
      if (isPaymentSettledStatus(payment?.status)) throw new Error('irrelevant_payment_link_already_settled');
      if (isPaymentManualArrangementStatus(payment?.status)) throw new Error('irrelevant_payment_link_manual_arrangement');
      const manageUrl = await deps.buildManageUrl(deps.bookingSiteUrl(ctx), booking);
      const policy = await getBookingPolicyConfig(ctx.providers.repository);
      await ctx.providers.email.sendBookingPaymentDue(
        booking,
        payUrl,
        manageUrl,
        new Date(new Date(booking.starts_at).getTime() - policy.paymentDueBeforeStartHours * 60 * 60 * 1000).toISOString(),
      );
      return { booking };
    },
    SEND_PAYMENT_REMINDER: async ({ booking, ctx }) => {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      const payUrl = payment?.invoice_url ?? payment?.checkout_url ?? deps.buildContinuePaymentUrl(deps.bookingSiteUrl(ctx), booking);
      if (!payUrl) throw new Error('checkout_url_missing');
      if (!booking.event_id) {
        await ctx.providers.email.sendBookingPaymentReminder(booking, payUrl);
      } else {
        const eventRecord = await ctx.providers.repository.getEventById(booking.event_id);
        if (!eventRecord) throw new Error('event_not_found');
        await ctx.providers.email.sendEventFollowup(booking, eventRecord, payUrl);
      }
      return { booking };
    },
    RESERVE_CALENDAR_SLOT: async ({ booking, ctx }) => withCalendarResult(
      await deps.retryCalendarSyncForBooking(booking, booking.google_event_id ? 'update' : 'create', ctx),
    ),
    UPDATE_CALENDAR_SLOT: async ({ booking, ctx }) => withCalendarResult(
      await deps.retryCalendarSyncForBooking(booking, 'update', ctx),
    ),
    CANCEL_CALENDAR_SLOT: async ({ booking, ctx }) => withCalendarResult(
      await deps.retryCalendarSyncForBooking(booking, 'delete', ctx),
    ),
    SEND_BOOKING_EXPIRATION_NOTIFICATION: async ({ booking, ctx }) => {
      await ctx.providers.email.sendBookingExpired(booking, deps.buildStartNewBookingUrl(deps.bookingSiteUrl(ctx), booking));
      return { booking };
    },
    SEND_BOOKING_CANCELLATION_CONFIRMATION: async ({ booking, ctx }) => {
      await deps.sendBookingCancellationConfirmation(booking, ctx);
      return { booking };
    },
    SEND_BOOKING_CONFIRMATION: async ({ booking, ctx }) => {
      await deps.sendBookingFinalConfirmation(booking, ctx);
      return { booking };
    },
    SEND_BOOKING_REFUND_CONFIRMATION: async ({ booking, effect, ctx }) => {
      await deps.sendRefundConfirmationEmailForBooking(booking, effect, ctx);
      return { booking };
    },
    SEND_EVENT_REMINDER: async ({ booking, ctx }) => {
      await deps.send24hBookingReminder(booking, ctx);
      return { booking };
    },
    CREATE_STRIPE_CHECKOUT: async ({ booking, ctx }) => {
      const checkout = await deps.ensureCheckoutForBooking(booking, ctx);
      return {
        booking,
        metadata: {
          checkout_url: checkout.checkoutUrl,
          checkout_hold_expires_at: checkout.expiresAt,
        },
      };
    },
    CREATE_STRIPE_REFUND: async ({ booking, ctx }) => {
      ctx.logger.logInfo?.({
        source: 'backend',
        eventType: 'side_effect_execution_step',
        message: 'Dispatching CREATE_STRIPE_REFUND through refund service',
        context: {
          booking_id: booking.id,
          side_effect_intent: 'CREATE_STRIPE_REFUND',
          branch_taken: 'execute_create_stripe_refund_handler',
          deny_reason: null,
        },
      });
      const refundResult = await deps.initiateAutomaticCancellationRefund(booking, ctx);
      ctx.logger.logInfo?.({
        source: 'backend',
        eventType: 'side_effect_execution_step',
        message: 'CREATE_STRIPE_REFUND returned from refund service',
        context: {
          booking_id: booking.id,
          side_effect_intent: 'CREATE_STRIPE_REFUND',
          refund_eligible: refundResult.decision.eligible,
          next_side_effect_count: refundResult.nextSideEffects.length,
          branch_taken: 'complete_create_stripe_refund_handler',
          deny_reason: null,
        },
      });
      return {
        booking,
        nextSideEffects: refundResult.nextSideEffects,
      };
    },
    VERIFY_EMAIL_CONFIRMATION: async ({ booking, event, effect, ctx, sourceOperation }) => {
      if (sourceOperation === 'confirm_booking_email_verification') {
        const verificationResult = await deps.completeEmailVerificationWithinEvent(effect.booking_event_id, booking, ctx);
        return {
          ...verificationResult,
          nextSideEffects: (verificationResult.nextSideEffects ?? []).map((nextEffect) => ({
            effect: nextEffect,
            event,
          })),
        };
      }
      if (booking.current_status === 'PENDING') {
        return { booking: await deps.expireBooking(booking, ctx) };
      }
      return { booking };
    },
    VERIFY_STRIPE_PAYMENT: async ({ booking, effect, ctx, triggerSource, sourceOperation }) => {
      const payment = await ctx.providers.repository.getPaymentByBookingId(booking.id);
      if (isPaymentSettledStatus(payment?.status)) {
        const transition = await appendBookingEventWithEffects(
          booking.id,
          'PAYMENT_SETTLED',
          triggerSource === 'cron' ? 'SYSTEM' : 'WEBHOOK',
          {
            side_effect_id: effect.id,
            stripe_checkout_session_id: payment?.stripe_checkout_session_id,
            stripe_payment_intent_id: payment?.stripe_payment_intent_id,
            stripe_invoice_id: payment?.stripe_invoice_id,
          },
          ctx,
          {
            booking,
            payment,
          },
        );
        const executed = await deps.runImmediateBookingEventWorkflow({
          transitionEvent: transition.event,
          transitionEventType: 'PAYMENT_SETTLED',
          sourceOperation: `${sourceOperation}:payment_settled`,
          bookingBeforeTransition: booking,
          bookingAfterTransition: transition.booking,
          transitionSideEffects: transition.sideEffects as BookingSideEffectExecutorInput['effect'][],
        }, ctx);
        return { booking: executed.booking };
      }
      if (isPaymentExpiryTrackedStatus(payment?.status ?? null)) {
        return { booking: await deps.expireBooking(booking, ctx) };
      }
      return { booking };
    },
  };
}

export function createBookingSideEffectExecutor(deps: ExecutorDeps) {
  const handlers = makeHandlerMap(deps);
  return async function executeBookingSideEffectAction(
    input: BookingSideEffectExecutorInput,
  ): Promise<BookingSideEffectExecutorResult> {
    const handler = handlers[input.effect.effect_intent as BookingEffectIntent];
    if (!handler) {
      throw new Error(`unknown_effect_intent:${input.effect.effect_intent}`);
    }
    return handler(input);
  };
}
