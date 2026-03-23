import { notFound } from '../lib/errors.js';
import { isTerminalStatus } from '../domain/booking-domain.js';
import {
  isPaymentContinuableOnline,
  isPaymentSettledStatus,
} from '../domain/payment-status.js';
import { effectiveRefundStatus } from './refund-service.js';
import { finalizeBookingEventStatus } from './booking-event-workflow.js';
import {
  loadBookingWithLatestPayment,
  loadBookingWithLatestPaymentAndSelectedEvent,
} from './booking-read-model.js';
import {
  buildContinuePaymentUrl,
  buildManageUrl,
  bookingSiteUrl,
  buildPublicCalendarEventInfo,
  canContinuePayLaterPayment,
  isSessionCalendarSyncPendingRetry,
  paymentProviderUrl,
  type BookingContext,
  type BookingEventStatusSelector,
  type BookingPublicActionInfo,
} from './booking-service.js';
import {
  resolveBookingAccessByIdOrConfirmToken,
  resolveBookingEventAccess,
} from './booking-access-service.js';
import type { Booking, BookingCurrentStatus, BookingEventRecord, Payment } from '../types.js';

const MANAGE_BLOCKED_STATUSES: readonly BookingCurrentStatus[] = ['EXPIRED', 'CANCELED', 'COMPLETED', 'NO_SHOW'];

interface BookingPublicActionState {
  manageUrl: string | null;
  checkoutUrl: string | null;
}

export interface ManageActionState {
  source: 'event' | 'session';
  canReschedule: boolean;
  canCancel: boolean;
  canCompletePayment: boolean;
  continuePaymentUrl: string | null;
  isPaid: boolean;
}

export async function buildBookingPublicActionInfoFromState(
  booking: Booking,
  payment: Payment | null,
  ctx: BookingContext,
): Promise<BookingPublicActionInfo> {
  const actionState = await resolveBookingPublicActionState(booking, payment, ctx);
  const event = booking.event_id
    ? await ctx.providers.repository.getEventById(booking.event_id)
    : null;

  if (actionState.checkoutUrl) {
    return {
      booking,
      checkoutUrl: actionState.checkoutUrl,
      manageUrl: actionState.manageUrl,
      nextActionUrl: actionState.checkoutUrl,
      nextActionLabel: 'Complete Payment',
      calendarEvent: buildPublicCalendarEventInfo(booking, event),
      calendarSyncPendingRetry: isSessionCalendarSyncPendingRetry(booking),
    };
  }

  return {
    booking,
    checkoutUrl: actionState.checkoutUrl,
    manageUrl: actionState.manageUrl,
    nextActionUrl: actionState.manageUrl,
    nextActionLabel: actionState.manageUrl ? 'Manage Booking' : null,
    calendarEvent: buildPublicCalendarEventInfo(booking, event),
    calendarSyncPendingRetry: isSessionCalendarSyncPendingRetry(booking),
  };
}

export async function getBookingPublicActionInfo(
  booking: Booking,
  ctx: BookingContext,
): Promise<BookingPublicActionInfo> {
  const readModel = booking.booking_type === 'FREE'
    ? { booking, payment: null as Payment | null }
    : await loadBookingWithLatestPayment({
      booking,
    }, ctx);
  return buildBookingPublicActionInfoFromState(readModel.booking, readModel.payment, ctx);
}

export async function getBookingEventStatusSnapshot(
  selector: BookingEventStatusSelector,
  rawToken: string,
  rawAdminToken: string | null,
  ctx: BookingContext,
): Promise<{
  event: BookingEventRecord;
  booking: Booking;
  isTerminal: boolean;
  message: string;
  checkoutUrl: string | null;
  refund: {
    status: string;
    invoiceUrl: string | null;
    receiptUrl: string | null;
    creditNoteUrl: string | null;
  } | null;
  manageUrl: string | null;
  nextActionUrl: string | null;
  nextActionLabel: 'Complete Payment' | 'Manage Booking' | null;
  calendarEvent: ReturnType<typeof buildPublicCalendarEventInfo>;
  calendarSyncPendingRetry: boolean;
}> {
  const access = selector.mode === 'by_id'
    ? await resolveBookingEventAccess(selector.bookingEventId, rawToken, rawAdminToken, ctx)
    : {
        booking: await resolveBookingAccessByIdOrConfirmToken(selector.bookingId, rawToken, rawAdminToken, ctx),
        event: null,
      };
  const readModel = await loadBookingWithLatestPaymentAndSelectedEvent({
    booking: access.booking,
    event: selector.mode === 'by_id'
      ? { mode: 'by_id', eventId: access.event?.id ?? selector.bookingEventId }
      : { mode: 'latest_of_type', eventType: selector.eventType },
  }, ctx);
  const booking = readModel.booking;
  const payment = readModel.payment;
  const selectedEvent = readModel.selectedEvent ?? access.event;
  if (!selectedEvent) throw notFound('Booking event not found');
  let resolvedEvent = selectedEvent;
  const reconciledEvent = await finalizeBookingEventStatus(selectedEvent.id, ctx, {
    startedExecution: selectedEvent.status === 'PROCESSING',
    reconcileProcessing: selectedEvent.status === 'PROCESSING',
  });
  if (reconciledEvent.status !== selectedEvent.status) {
    const refreshedReadModel = await loadBookingWithLatestPaymentAndSelectedEvent({
      booking: access.booking,
      event: selector.mode === 'by_id'
        ? { mode: 'by_id', eventId: access.event?.id ?? selector.bookingEventId }
        : { mode: 'latest_of_type', eventType: selector.eventType },
    }, ctx);
    resolvedEvent = refreshedReadModel.selectedEvent ?? reconciledEvent;
  } else {
    resolvedEvent = reconciledEvent;
  }
  const actionState = await resolveBookingPublicActionState(booking, payment, ctx);
  const eventRecord = booking.event_id
    ? await ctx.providers.repository.getEventById(booking.event_id)
    : null;
  const refundStatus = effectiveRefundStatus(payment);
  const refund = refundStatus !== 'NONE'
    ? {
        status: refundStatus,
        invoiceUrl: payment?.invoice_url ?? null,
        receiptUrl: payment?.stripe_receipt_url ?? null,
        creditNoteUrl: payment?.stripe_credit_note_url ?? null,
      }
    : null;
  const checkoutUrl = payment?.checkout_url ?? null;
  const message = resolvedEvent.event_type === 'BOOKING_CANCELED'
    ? refundStatus === 'SUCCEEDED'
      ? 'Booking cancelled and refund processed.'
      : 'Booking cancelled.'
    : resolvedEvent.event_type === 'BOOKING_RESCHEDULED'
      ? 'Booking rescheduled.'
      : resolvedEvent.event_type === 'BOOKING_FORM_SUBMITTED' && checkoutUrl
        ? 'Payment checkout is ready.'
        : resolvedEvent.status === 'FAILED'
          ? 'This action could not be completed.'
          : 'This action is still processing.';

  return {
    event: resolvedEvent,
    booking,
    isTerminal: resolvedEvent.status === 'SUCCESS' || resolvedEvent.status === 'FAILED',
    message,
    checkoutUrl,
    refund,
    manageUrl: actionState.manageUrl,
    nextActionUrl: actionState.checkoutUrl ?? actionState.manageUrl,
    nextActionLabel: actionState.checkoutUrl
      ? 'Complete Payment'
      : actionState.manageUrl
        ? 'Manage Booking'
        : null,
    calendarEvent: buildPublicCalendarEventInfo(booking, eventRecord),
    calendarSyncPendingRetry: isSessionCalendarSyncPendingRetry(booking),
  };
}

export async function resolveManageActionState(input: {
  booking: Booking;
  payment: Payment | null;
  bypassPolicyWindow: boolean;
  canSelfServeChange: boolean;
  siteUrl: string;
}): Promise<ManageActionState> {
  const source: 'event' | 'session' = input.booking.event_id ? 'event' : 'session';
  const blocked = MANAGE_BLOCKED_STATUSES.includes(input.booking.current_status);
  const canReschedule = source === 'session'
    && (input.bypassPolicyWindow || input.canSelfServeChange)
    && !blocked;
  const canCancel = (input.bypassPolicyWindow || input.canSelfServeChange) && !blocked;
  const isPaid = isPaymentSettledStatus(input.payment?.status);
  const canCompletePayment = input.booking.booking_type === 'PAY_LATER'
    && !isPaid
    && !blocked;
  const continuePaymentUrl = canCompletePayment
    ? buildContinuePaymentUrl(input.siteUrl, input.booking)
    : null;

  return {
    source,
    canReschedule,
    canCancel,
    canCompletePayment,
    continuePaymentUrl,
    isPaid,
  };
}

export function evaluateManageBookingPolicy(startsAtIso: string, selfServiceLockWindowHours: number): {
  canSelfServeChange: boolean;
  hoursBeforeStart: number;
} {
  const nowMs = Date.now();
  const startsAtMs = new Date(startsAtIso).getTime();
  const hoursBeforeStart = (startsAtMs - nowMs) / 3_600_000;
  return {
    canSelfServeChange: hoursBeforeStart >= selfServiceLockWindowHours,
    hoursBeforeStart,
  };
}

async function resolveBookingPublicActionState(
  booking: Booking,
  payment: Payment | null,
  ctx: BookingContext,
): Promise<BookingPublicActionState> {
  const manageUrl = isTerminalStatus(booking.current_status)
    ? null
    : await buildManageUrl(bookingSiteUrl(ctx), booking);
  const checkoutUrl = payment && canContinuePayLaterPayment(booking, payment.status)
    ? buildContinuePaymentUrl(bookingSiteUrl(ctx), booking)
    : payment
      && !isTerminalStatus(booking.current_status)
      && booking.booking_type !== 'PAY_LATER'
      && isPaymentContinuableOnline(payment.status)
      && Boolean(paymentProviderUrl(payment))
      ? buildContinuePaymentUrl(bookingSiteUrl(ctx), booking)
      : null;

  return {
    manageUrl,
    checkoutUrl,
  };
}
