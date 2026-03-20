import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  handleAdminGetSessionTypes,
  handleAdminGetSessionTypeDetail,
  handleAdminCreateSessionType,
  handleAdminUpdateSessionType,
  handleAdminUpsertSessionTypeAvailabilityOverride,
} from '../src/handlers/session-types.js';
import { resetMockSessionTypesForTests } from '../src/providers/repository/mock.js';
import { adminRequest, makeCtx } from './admin-helpers.js';

describe('Admin session types', () => {
  afterEach(() => {
    resetMockSessionTypesForTests();
  });

  it('lists all session types', async () => {
    const rows = [{ id: 's1', title: 'A' }];
    const ctx = makeCtx({ providers: { repository: { getAllSessionTypes: vi.fn().mockResolvedValue(rows) } } });
    const res = await handleAdminGetSessionTypes(adminRequest('GET', 'https://api.local/api/admin/session-types'), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_types).toEqual(rows);
  });

  it('validates required fields on create', async () => {
    const ctx = makeCtx({ providers: { repository: {} } });
    await expect(handleAdminCreateSessionType(adminRequest('POST', 'https://api.local/api/admin/session-types', { title: 'T' }), ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'slug is required',
    });
  });

  it('creates a new session type', async () => {
    const row = { id: 's2', title: 'T', slug: 't' };
    const repo = { createSessionType: vi.fn().mockResolvedValue(row) };
    const ctx = makeCtx({ providers: { repository: repo } });
    const payload = { title: 'T', slug: 't', description: 'd', duration_minutes: 60, price: 120.5, currency: 'CHF', status: 'draft' };
    const res = await handleAdminCreateSessionType(adminRequest('POST', 'https://api.local/api/admin/session-types', payload), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session_type).toEqual(row);
    expect(repo.createSessionType).toHaveBeenCalledWith(expect.objectContaining({ price: 120.5 }));
  });

  it('returns session-type availability detail with windows and upcoming week summaries', async () => {
    const ctx = makeCtx();
    await ctx.providers.repository.updateSessionType('mock-st-1', {
      availability_mode: 'dedicated',
      availability_timezone: 'Europe/Zurich',
      weekly_booking_limit: 3,
      slot_step_minutes: 30,
    });
    await ctx.providers.repository.replaceSessionTypeAvailabilityWindows('mock-st-1', [
      {
        session_type_id: 'mock-st-1',
        weekday_iso: 4,
        start_local_time: '11:00:00',
        end_local_time: '13:00:00',
        sort_order: 0,
        active: true,
      },
    ]);

    const res = await handleAdminGetSessionTypeDetail(
      adminRequest('GET', 'https://api.local/api/admin/session-types/mock-st-1'),
      ctx,
      { id: 'mock-st-1' },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.session_type).toEqual(expect.objectContaining({
      id: 'mock-st-1',
      availability_mode: 'dedicated',
      weekly_booking_limit: 3,
    }));
    expect(body.availability.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ weekday_iso: 4, start_local_time: '11:00:00' }),
    ]));
    expect(Array.isArray(body.availability.upcoming_weeks)).toBe(true);
  });

  it('updates a week override and returns the refreshed week summary', async () => {
    const ctx = makeCtx();

    const res = await handleAdminUpsertSessionTypeAvailabilityOverride(
      adminRequest('PUT', 'https://api.local/api/admin/session-types/mock-st-1/availability-overrides/2026-03-23', {
        mode: 'FORCE_CLOSED',
        override_weekly_booking_limit: null,
      }),
      ctx,
      { id: 'mock-st-1', weekStartDate: '2026-03-23' },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.override).toEqual(expect.objectContaining({
      session_type_id: 'mock-st-1',
      week_start_date: '2026-03-23',
      mode: 'FORCE_CLOSED',
    }));
    expect(body.week_summary).toEqual(expect.objectContaining({
      week_start_date: '2026-03-23',
      mode: 'FORCE_CLOSED',
      branch_taken: 'deny_session_type_week_force_closed',
      deny_reason: 'session_type_week_force_closed',
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_session_type_availability_override_mutation_completed',
      context: expect.objectContaining({
        branch_taken: 'session_type_week_override_upserted',
        override_mode: 'FORCE_CLOSED',
      }),
    }));
  });
});
