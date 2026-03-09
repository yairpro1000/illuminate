import type { Booking } from '../types.js';
import type { Providers } from '../providers/index.js';
import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import { mapLegacyToState, type BookingEventSource, type BookingEventType, mapEventForNote } from '../domain/booking-domain.js';

export interface TransitionContext {
  providers: Providers;
  env: Env;
  logger: Logger;
  requestId: string;
}

export async function syncStateFromLegacy(booking: Booking, ctx: TransitionContext, source: BookingEventSource, eventType: BookingEventType, payload?: unknown): Promise<Booking> {
  const updates = mapLegacyToState(booking);
  const updated = await ctx.providers.repository.updateBooking(booking.id, updates);
  await recordEvent(ctx, booking.id, eventType, source, payload);
  return updated;
}

export async function recordEvent(ctx: TransitionContext, bookingId: string, eventType: BookingEventType, source: BookingEventSource, payload?: unknown): Promise<void> {
  try {
    await ctx.providers.repository.createBookingEvent({
      booking_id: bookingId,
      event_type: eventType,
      source,
      payload: mapEventForNote(payload),
    });
  } catch (err) {
    ctx.logger.error('Failed to persist booking event', {
      bookingId,
      eventType,
      source,
      err: String(err),
    });
  }
}

export async function setLifecycle(
  booking: Booking,
  next: Partial<Pick<Booking,
    'booking_status' | 'payment_mode' | 'payment_status_v2' | 'email_status' | 'calendar_status' | 'slot_status' |
    'hold_expires_at' | 'payment_due_at' | 'reminder_36h_sent_at' | 'email_confirmed_at' | 'confirmed_at' | 'cancelled_at' | 'expired_at' | 'expired_reason' | 'cancel_reason'>>,
  ctx: TransitionContext,
  source: BookingEventSource,
  eventType: BookingEventType,
  payload?: unknown,
): Promise<Booking> {
  const updated = await ctx.providers.repository.updateBooking(booking.id, next);
  await recordEvent(ctx, booking.id, eventType, source, payload);
  return updated;
}
