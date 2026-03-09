import type {
  Booking,
  BookingLifecycleStatus,
  CalendarSubStatus,
  EmailSubStatus,
  PaymentMode,
  PaymentSubStatus,
  SlotSubStatus,
} from '../types.js';

export type BookingEventType =
  | 'BOOKING_CREATED'
  | 'EMAIL_CONFIRMED'
  | 'PAYMENT_SUCCEEDED'
  | 'HOLD_EXPIRED'
  | 'PAY_LATER_REMINDER_DUE'
  | 'PAYMENT_DEADLINE_MISSED'
  | 'USER_CANCELLED'
  | 'ADMIN_CANCELLED'
  | 'USER_RESCHEDULED'
  | 'CALENDAR_EVENT_CREATED'
  | 'CALENDAR_EVENT_REMOVED';

export type BookingEventSource = 'ui' | 'webhook' | 'cron' | 'admin' | 'system';

export interface BookingState {
  booking_status: BookingLifecycleStatus;
  payment_mode: PaymentMode;
  payment_status: PaymentSubStatus;
  email_status: EmailSubStatus;
  calendar_status: CalendarSubStatus;
  slot_status: SlotSubStatus;
}

export function mapLegacyToState(booking: Booking): Partial<Booking> & BookingState {
  const isSession = booking.source === 'session';
  const isEvent = booking.source === 'event';

  // Determine payment_mode from legacy shape
  let payment_mode: PaymentMode = 'free';
  if (isEvent) {
    payment_mode = booking.checkout_hold_expires_at ? 'pay_now' : (booking.payment_due_at ? 'pay_later' : 'free');
  } else if (isSession) {
    if (booking.session_type === 'intro') payment_mode = 'free';
    else if (booking.checkout_hold_expires_at) payment_mode = 'pay_now';
    else if (booking.payment_due_at) payment_mode = 'pay_later';
    else payment_mode = 'pay_later'; // default for sessions
  }

  // Map legacy top-level to new booking_status
  let booking_status: BookingLifecycleStatus = 'pending';
  switch (booking.status) {
    case 'confirmed':
    case 'cash_ok':
      booking_status = 'confirmed';
      break;
    case 'cancelled':
      booking_status = 'cancelled';
      break;
    case 'expired':
      booking_status = 'expired';
      break;
    case 'pending_payment':
      // Distinguish pay_now hold vs pay_later post-confirmation using dues/holds
      if (booking.payment_due_at) booking_status = 'confirmed';
      else booking_status = 'pending';
      break;
    default:
      booking_status = 'pending';
  }

  // Email sub-status
  let email_status: EmailSubStatus = 'not_required';
  if (payment_mode === 'pay_now') {
    email_status = 'not_required';
  } else if (booking.status === 'pending_email') {
    email_status = 'pending_confirmation';
  } else if (booking.status === 'expired') {
    email_status = 'expired';
  } else {
    // confirmed or pay-later post-confirm
    email_status = 'confirmed';
  }

  // Payment sub-status
  let payment_status: PaymentSubStatus = 'not_required';
  if (payment_mode === 'free') payment_status = 'not_required';
  else if (payment_mode === 'pay_now') payment_status = booking_status === 'confirmed' ? 'paid' : 'pending';
  else if (payment_mode === 'pay_later') payment_status = 'pending';

  // Calendar
  let calendar_status: CalendarSubStatus = 'not_required';
  if (isSession) {
    calendar_status = booking.google_event_id ? 'created' : (booking_status === 'confirmed' ? 'pending' : 'not_required');
  } else {
    calendar_status = 'not_required';
  }

  // Slot reservation
  const now = new Date();
  const withinHold = booking.checkout_hold_expires_at ? new Date(booking.checkout_hold_expires_at) > now : false;
  let slot_status: SlotSubStatus = 'released';
  if (booking_status === 'confirmed') slot_status = 'reserved';
  else if (withinHold) slot_status = 'reserved';

  // Derived hold alias
  const hold_expires_at = booking.checkout_hold_expires_at ?? null;

  return {
    booking_status,
    payment_mode,
    payment_status_v2: payment_status,
    // legacy field required by `BookingState` — keep in sync with v2
    payment_status: payment_status,
    email_status,
    calendar_status,
    slot_status,
    hold_expires_at,
  };
}

export function mapEventForNote(payload?: unknown): Record<string, unknown> {
  if (!payload) return {};
  try {
    return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : { value: String(payload) };
  } catch {
    return { value: String(payload) };
  }
}
