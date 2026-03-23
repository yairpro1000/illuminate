import { describe, expect, it } from 'vitest';

import { SupabaseRepository } from '../src/providers/repository/supabase.js';
import { ApiError } from '../src/lib/errors.js';

describe('SupabaseRepository diagnosable errors', () => {
  it('includes concrete Supabase error metadata in thrown query failures', async () => {
    const repo = new SupabaseRepository({
      from: () => ({
        select: () => ({
          in: () => ({
            order: async () => ({
              data: null,
              error: {
                message: 'column events.capacity does not exist',
                code: '42703',
                details: null,
                hint: 'Perhaps you meant to reference a different column.',
                status: 400,
              },
            }),
          }),
        }),
      }),
    } as any);

    await expect(repo.getPublishedEvents()).rejects.toThrow(
      'Failed to load published events: column events.capacity does not exist | code=42703 | hint=Perhaps you meant to reference a different column. | status=400',
    );
  });

  it('maps active slot overlap constraint failures to a clean conflict error', async () => {
    const repo = new SupabaseRepository({
      from: (table: string) => {
        if (table !== 'bookings') throw new Error(`unexpected table ${table}`);
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: null,
                error: {
                  message: 'conflicting key value violates exclusion constraint "no_overlapping_active_bookings"',
                  code: '23P01',
                  details: null,
                  hint: null,
                  status: 409,
                },
              }),
            }),
          }),
        };
      },
    } as any);

    await expect(repo.createBooking({
      client_id: 'client-1',
      event_id: null,
      session_type_id: 'session-1',
      booking_type: 'FREE',
      starts_at: '2026-03-20T14:00:00+01:00',
      ends_at: '2026-03-20T14:30:00+01:00',
      timezone: 'Europe/Zurich',
      google_event_id: null,
      address_line: 'Somewhere 1, Zurich',
      maps_url: 'https://maps.example',
      current_status: 'PENDING',
      notes: null,
    })).rejects.toMatchObject<ApiError>({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'This slot is no longer available',
    });
  });

  it('allows clearing and replacing availability windows when delete returns null data', async () => {
    const insertedRows = [
      {
        id: 'window-1',
        session_type_id: 'session-1',
        weekday_iso: 4,
        start_local_time: '11:00:00',
        end_local_time: '13:00:00',
        sort_order: 0,
        active: true,
        created_at: '2026-03-20T00:00:00.000Z',
        updated_at: '2026-03-20T00:00:00.000Z',
      },
    ];
    const repo = new SupabaseRepository({
      from: (table: string) => {
        if (table !== 'session_type_availability_windows') throw new Error(`unexpected table ${table}`);
        return {
          delete: () => ({
            eq: async (column: string, value: string) => {
              expect(column).toBe('session_type_id');
              expect(value).toBe('session-1');
              return { data: null, error: null };
            },
          }),
          insert: (rows: unknown) => {
            expect(rows).toEqual([
              {
                session_type_id: 'session-1',
                weekday_iso: 4,
                start_local_time: '11:00',
                end_local_time: '13:00',
                sort_order: 0,
                active: true,
              },
            ]);
            return {
              select: () => ({
                order: () => ({
                  order: async () => ({ data: insertedRows, error: null }),
                }),
              }),
            };
          },
        };
      },
    } as any);

    await expect(repo.replaceSessionTypeAvailabilityWindows('session-1', [
      {
        session_type_id: 'session-1',
        weekday_iso: 4,
        start_local_time: '11:00',
        end_local_time: '13:00',
        sort_order: 0,
        active: true,
      },
    ])).resolves.toEqual(insertedRows);
  });

  it('batches organizer side effect attempt lookups to avoid oversized in-filters', async () => {
    const sideEffectIds = Array.from({ length: 201 }, (_, index) => `effect-${index + 1}`);
    const attemptBatchSizes: number[] = [];

    const repo = new SupabaseRepository({
      from: (table: string) => {
        if (table === 'bookings') {
          return {
            select: () => ({
              order: async () => ({
                data: [{
                  id: 'booking-1',
                  client_id: 'client-1',
                  event_id: null,
                  session_type_id: 'session-1',
                  booking_type: 'PAY_NOW',
                  starts_at: '2026-04-01T15:00:00.000Z',
                  ends_at: '2026-04-01T16:00:00.000Z',
                  timezone: 'Europe/Zurich',
                  google_event_id: null,
                  meeting_provider: null,
                  meeting_link: null,
                  address_line: 'Via Example 1, Lugano',
                  maps_url: 'https://maps.example',
                  price: 150,
                  currency: 'CHF',
                  coupon_code: null,
                  current_status: 'CONFIRMED',
                  notes: null,
                  created_at: '2026-03-20T10:00:00.000Z',
                  updated_at: '2026-03-20T10:00:00.000Z',
                  client: {
                    first_name: 'Maya',
                    last_name: 'Doe',
                    email: 'maya@example.com',
                    phone: null,
                  },
                  event: null,
                  session_type: {
                    id: 'session-1',
                    title: 'First Clarity Session',
                  },
                }],
                error: null,
              }),
            }),
          };
        }

        if (table === 'booking_events') {
          return {
            select: () => ({
              in: () => ({
                order: async () => ({
                  data: [{
                    id: 'event-1',
                    booking_id: 'booking-1',
                    event_type: 'PAYMENT_SETTLED',
                    created_at: '2026-03-20T10:05:00.000Z',
                  }],
                  error: null,
                }),
              }),
            }),
          };
        }

        if (table === 'payments') {
          return {
            select: () => ({
              in: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }

        if (table === 'booking_side_effects') {
          return {
            select: () => ({
              in: () => ({
                order: async () => ({
                  data: sideEffectIds.map((id, index) => ({
                    id,
                    booking_event_id: 'event-1',
                    effect_intent: index === 0 ? 'CREATE_STRIPE_CHECKOUT' : 'SEND_BOOKING_CONFIRMATION',
                    created_at: `2026-03-20T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
                  })),
                  error: null,
                }),
              }),
            }),
          };
        }

        if (table === 'booking_side_effect_attempts') {
          return {
            select: () => ({
              in: (_column: string, ids: string[]) => {
                attemptBatchSizes.push(ids.length);
                return {
                  order: async () => ({
                    data: ids.map((id) => ({
                      booking_side_effect_id: id,
                      status: 'SUCCESS',
                      created_at: '2026-03-20T10:10:00.000Z',
                    })),
                    error: null,
                  }),
                };
              },
            }),
          };
        }

        throw new Error(`unexpected table ${table}`);
      },
    } as any);

    await expect(repo.getOrganizerBookings({})).resolves.toHaveLength(1);
    expect(attemptBatchSizes).toEqual([200, 1]);
  });
});
