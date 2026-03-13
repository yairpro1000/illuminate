import { afterEach, describe, it, expect, vi } from 'vitest';
import { handleAdminCreateLateAccessLink } from '../src/handlers/admin.js';
import {
  applyBookingPolicyOverridesForTests,
  resetBookingPolicyForTests,
} from '../src/domain/booking-effect-policy.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

vi.mock('../src/services/token-service.js', () => ({
  generateToken: () => 'tok123',
  hashToken: async () => 'HASHED',
}));

describe('Admin late-access link', () => {
  afterEach(() => {
    resetBookingPolicyForTests();
  });

  it('fails for missing event', async () => {
    const ctx = makeCtx({ providers: { repository: { getEventById: vi.fn().mockResolvedValue(null) } } });
    const req = adminRequest('POST', 'https://api.local/api/admin/events/evt1/late-access-links');
    const res = await handleAdminCreateLateAccessLink(req, ctx, { eventId: 'evt1' });
    expect(res.status).toBe(404);
  });

  it('revokes old links, creates new and returns URL with token', async () => {
    const event = {
      id: 'evt1', slug: 'slug', title: 'Title',
      starts_at: '2026-04-01T18:00:00Z', ends_at: '2026-04-01T20:00:00Z', timezone: 'Europe/Zurich',
      address_line: 'Addr', is_paid: false, price_per_person_cents: 0,
    } as any;
    const repo = {
      getEventById: vi.fn().mockResolvedValue(event),
      revokeActiveEventLateAccessLinks: vi.fn().mockResolvedValue(undefined),
      createEventLateAccessLink: vi.fn().mockResolvedValue({ id: 'l1' }),
    };
    const ctx = makeCtx({ providers: { repository: repo } });
    const req = adminRequest('POST', 'https://api.local/api/admin/events/evt1/late-access-links');
    const res = await handleAdminCreateLateAccessLink(req, ctx, { eventId: 'evt1' });
    expect(res.status).toBe(201);
    expect(repo.revokeActiveEventLateAccessLinks).toHaveBeenCalledWith('evt1');
    expect(repo.createEventLateAccessLink).toHaveBeenCalledWith(expect.objectContaining({ event_id: 'evt1', token_hash: 'HASHED' }));
    const body = await res.json();
    expect(body.url).toContain('access=tok123');
    expect(body.expires_at).toBeTruthy();
  });

  it('uses configured late-access expiry hours', async () => {
    applyBookingPolicyOverridesForTests({ eventLateAccessLinkExpiryHours: 4 });

    const event = {
      id: 'evt1', slug: 'slug', title: 'Title',
      starts_at: '2026-04-01T18:00:00Z', ends_at: '2026-04-01T20:00:00Z', timezone: 'Europe/Zurich',
      address_line: 'Addr', is_paid: false, price_per_person_cents: 0,
    } as any;
    const repo = {
      getEventById: vi.fn().mockResolvedValue(event),
      revokeActiveEventLateAccessLinks: vi.fn().mockResolvedValue(undefined),
      createEventLateAccessLink: vi.fn().mockResolvedValue({ id: 'l1' }),
    };
    const ctx = makeCtx({ providers: { repository: repo } });
    const req = adminRequest('POST', 'https://api.local/api/admin/events/evt1/late-access-links');
    const res = await handleAdminCreateLateAccessLink(req, ctx, { eventId: 'evt1' });
    const body = await res.json();

    expect(body.expires_at).toBe('2026-04-02T00:00:00.000Z');
  });
});
