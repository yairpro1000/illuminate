import { badRequest, notFound } from '../lib/errors.js';
import { hashToken } from './token-service.js';
import { verifyAdminManageToken } from './token-service.js';
import type { Booking, BookingEventRecord } from '../types.js';
import type { Providers } from '../providers/index.js';
import type { BookingContext } from './booking-service.js';

function parseStableManageToken(rawToken: string): { bookingId: string } | null {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const parts = rawToken.split('.');
  if (parts.length === 2 && parts[0] === 'm1' && parts[1]) {
    return { bookingId: parts[1] };
  }
  return null;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function resolveBookingByManageToken(
  rawToken: string,
  repository: Providers['repository'],
): Promise<Booking> {
  const parsed = parseStableManageToken(rawToken);
  const bookingId = parsed?.bookingId ?? rawToken;
  if (!isUuidLike(bookingId)) {
    throw badRequest('Invalid manage token');
  }

  const booking = await repository.getBookingById(bookingId);
  if (!booking) throw notFound('Booking not found');
  return booking;
}

export async function resolveBookingManageAccess(
  rawToken: string,
  rawAdminToken: string | null,
  ctx: BookingContext,
): Promise<{ booking: Booking; actorSource: 'PUBLIC_UI' | 'ADMIN_UI'; bypassPolicyWindow: boolean }> {
  const booking = await resolveBookingByManageToken(rawToken, ctx.providers.repository);
  if (!rawAdminToken) {
    return { booking, actorSource: 'PUBLIC_UI', bypassPolicyWindow: false };
  }
  const secret = String(ctx.env.ADMIN_MANAGE_TOKEN_SECRET || ctx.env.JOB_SECRET || '').trim();
  if (!secret) {
    return { booking, actorSource: 'PUBLIC_UI', bypassPolicyWindow: false };
  }
  const verified = await verifyAdminManageToken(rawAdminToken, secret);
  if (!verified || verified.bookingId !== booking.id) {
    return { booking, actorSource: 'PUBLIC_UI', bypassPolicyWindow: false };
  }
  return { booking, actorSource: 'ADMIN_UI', bypassPolicyWindow: true };
}

export async function resolveBookingEventAccess(
  bookingEventId: string,
  rawToken: string,
  rawAdminToken: string | null,
  ctx: BookingContext,
): Promise<{ booking: Booking; event: BookingEventRecord }> {
  const event = await ctx.providers.repository.getBookingEventById(bookingEventId);
  if (!event) throw notFound('Booking event not found');

  try {
    const access = await resolveBookingManageAccess(rawToken, rawAdminToken, ctx);
    if (access.booking.id === event.booking_id) {
      return { booking: access.booking, event };
    }
  } catch {
    // Fall through to confirmation-token access.
  }

  const tokenHash = await hashToken(rawToken);
  const booking = await ctx.providers.repository.getBookingByConfirmTokenHash(tokenHash);
  if (booking?.id === event.booking_id) {
    return { booking, event };
  }

  throw notFound('Booking event not found');
}

export async function resolveBookingAccessByIdOrConfirmToken(
  bookingId: string,
  rawToken: string,
  rawAdminToken: string | null,
  ctx: BookingContext,
): Promise<Booking> {
  try {
    const access = await resolveBookingManageAccess(rawToken, rawAdminToken, ctx);
    if (access.booking.id === bookingId) {
      return access.booking;
    }
  } catch {
    // Fall through to confirmation-token access.
  }

  const tokenHash = await hashToken(rawToken);
  const booking = await ctx.providers.repository.getBookingByConfirmTokenHash(tokenHash);
  if (booking?.id === bookingId) {
    return booking;
  }

  throw notFound('Booking event not found');
}
