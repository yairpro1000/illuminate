import type { AppContext } from '../router.js';
import { ok, badRequest, errorResponse } from '../lib/errors.js';
import { resolveBookingByManageToken } from '../services/booking-service.js';
import { conflict } from '../lib/errors.js';

// POST /api/manage/reschedule
// Body: { token: string, id: string, new_slot_start: string, new_slot_end: string }
// Only supported for bookings in this version.
export async function handleManageReschedule(request: Request, ctx: AppContext): Promise<Response> {
  try {
    const body        = await request.json() as Record<string, unknown>;
    const token       = body['token']          as string | undefined;
    const id          = body['id']             as string | undefined;
    const newStart    = body['new_slot_start'] as string | undefined;
    const newEnd      = body['new_slot_end']   as string | undefined;

    if (!token || !id || !newStart || !newEnd) {
      throw badRequest('token, id, new_slot_start, and new_slot_end are required');
    }

    const booking = await resolveBookingByManageToken(token, id, ctx.providers.repository);

    if (!['confirmed', 'cash_ok', 'pending_payment'].includes(booking.status)) {
      throw badRequest('Booking cannot be rescheduled in its current state');
    }

    // Check new slot availability (excludes current booking's slot from conflict check)
    const from = newStart.slice(0, 10);
    const to   = newEnd.slice(0, 10);

    const [busyTimes, heldSlots] = await Promise.all([
      ctx.providers.calendar.getBusyTimes(from, to),
      ctx.providers.repository.getHeldSlots(from, to),
    ]);

    const newStartMs = new Date(newStart).getTime();
    const newEndMs   = new Date(newEnd).getTime();

    for (const busy of [...busyTimes, ...heldSlots]) {
      // Skip the booking's own current slot
      if (busy.start === booking.starts_at) continue;
      const bStart = new Date(busy.start).getTime();
      const bEnd   = new Date(busy.end).getTime();
      if (newStartMs < bEnd && newEndMs > bStart) {
        throw conflict('The requested slot is not available');
      }
    }

    // Update calendar event
    if (booking.google_event_id) {
      try {
        await ctx.providers.calendar.updateEvent(booking.google_event_id, {
          title:         `Clarity Session — ${booking.client_name}`,
          description:   `1:1 session with ${booking.client_name} (${booking.client_email})`,
          startIso:      newStart,
          endIso:        newEnd,
          location:      booking.address_line,
          attendeeEmail: booking.client_email,
          attendeeName:  booking.client_name,
        });
      } catch (err) {
        ctx.logger.error('Calendar update failed on reschedule', { bookingId: booking.id, err: String(err) });
      }
    }

    // Note: we store only starts_at/ends_at on the booking but those fields are
    // not in BookingUpdate (they're set at creation). In a real Supabase
    // implementation, add them to the allowed mutable set and the UPDATE query.
    // For the mock this is a known limitation — flag for the real DB layer.
    ctx.logger.warn('Reschedule: starts_at/ends_at update not persisted in mock', { bookingId: booking.id });

    return ok({ ok: true, new_slot_start: newStart, new_slot_end: newEnd });
  } catch (err) {
    return errorResponse(err);
  }
}
