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
});
