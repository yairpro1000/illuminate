import { describe, expect, it } from 'vitest';

import { SupabaseRepository } from '../src/providers/repository/supabase.js';

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
});
