import { describe, it, expect, vi } from 'vitest';
import {
  handleAdminCreateClient,
  handleAdminCreateClientBookingToken,
  handleAdminGetClients,
  handleAdminUpdateClient,
} from '../src/handlers/admin.js';
import { adminRequest, makeCtx } from './admin-helpers.js';
import { MockRepository } from '../src/providers/repository/mock.js';

describe('Admin clients', () => {
  it('lists admin clients and logs the success branch', async () => {
    const listAdminClients = vi.fn().mockResolvedValue([{ id: 'c1', first_name: 'Maya', last_name: 'Doe', email: 'maya@example.com', phone: null, sessions_count: 1, last_session_at: '2026-03-28T10:00:00.000Z', events_count: 0, last_event_at: null }]);
    const ctx = makeCtx({ providers: { repository: { listAdminClients } } });

    const res = await handleAdminGetClients(adminRequest('GET', 'https://api.local/api/admin/clients'), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rows).toHaveLength(1);
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_clients_list_request_succeeded',
      context: expect.objectContaining({ branch_taken: 'return_clients', row_count: 1 }),
    }));
  });

  it('creates a client and normalizes duplicate-email errors', async () => {
    const createClient = vi.fn().mockRejectedValue(new Error('duplicate key value code=23505 email'));
    const ctx = makeCtx({ providers: { repository: { createClient } } });

    await expect(handleAdminCreateClient(adminRequest('POST', 'https://api.local/api/admin/clients', {
      first_name: 'Maya',
      email: 'maya@example.com',
    }), ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'A client with this email already exists',
    });

    expect(ctx.logger.logWarn).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_client_create_failed',
      context: expect.objectContaining({ branch_taken: 'handled_api_error', deny_reason: 'CONFLICT' }),
    }));
  });

  it('updates the client and syncs Stripe customer email when present', async () => {
    const getClientById = vi.fn().mockResolvedValue({
      id: 'c1',
      first_name: 'Maya',
      last_name: 'Doe',
      email: 'maya@example.com',
      phone: null,
      stripe_customer_id: 'cus_123',
      created_at: '2026-03-01T10:00:00.000Z',
      updated_at: '2026-03-01T10:00:00.000Z',
    });
    const updateClient = vi.fn().mockResolvedValue({
      id: 'c1',
      first_name: 'Maya',
      last_name: 'Doe',
      email: 'maya.new@example.com',
      phone: null,
      stripe_customer_id: 'cus_123',
      created_at: '2026-03-01T10:00:00.000Z',
      updated_at: '2026-03-30T10:00:00.000Z',
    });
    const getAdminClientRowById = vi.fn().mockResolvedValue({
      id: 'c1',
      first_name: 'Maya',
      last_name: 'Doe',
      email: 'maya.new@example.com',
      phone: null,
      sessions_count: 2,
      last_session_at: '2026-03-28T10:00:00.000Z',
      events_count: 1,
      last_event_at: '2026-03-29T10:00:00.000Z',
    });
    const updateCustomer = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      providers: {
        repository: { getClientById, updateClient, getAdminClientRowById },
        payments: { updateCustomer },
      },
    });

    const res = await handleAdminUpdateClient(adminRequest('PATCH', 'https://api.local/api/admin/clients/c1', {
      first_name: 'Maya',
      email: 'maya.new@example.com',
    }), ctx, { clientId: 'c1' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.client.email).toBe('maya.new@example.com');
    expect(updateCustomer).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cus_123',
      email: 'maya.new@example.com',
      name: 'Maya Doe',
    }));
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_client_update_stripe_sync_succeeded',
      context: expect.objectContaining({ branch_taken: 'stripe_customer_email_synced' }),
    }));
  });

  it('creates a booking token for a client through the shared token owner', async () => {
    const getClientById = vi.fn().mockResolvedValue({
      id: 'c1',
      first_name: 'Maya',
      last_name: 'Doe',
      email: 'maya@example.com',
      phone: null,
      created_at: '2026-03-01T10:00:00.000Z',
      updated_at: '2026-03-01T10:00:00.000Z',
    });
    const ctx = makeCtx({
      env: { JOB_SECRET: 'secret', ADMIN_MANAGE_TOKEN_SECRET: 'secret' } as any,
      providers: { repository: { getClientById } },
    });

    const res = await handleAdminCreateClientBookingToken(
      adminRequest('POST', 'https://api.local/api/admin/clients/c1/booking-token'),
      ctx,
      { clientId: 'c1' },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.client_id).toBe('c1');
    expect(typeof body.token).toBe('string');
    expect(body.token).toContain('am1.c1.');
    expect(ctx.logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_client_booking_token_create_succeeded',
      context: expect.objectContaining({ branch_taken: 'return_admin_booking_token', client_id: 'c1' }),
    }));
  });

  it('counts only confirmed, completed, and no-show bookings in client aggregates', async () => {
    const repository = new MockRepository();
    const client = await repository.createClient({
      first_name: 'Maya',
      last_name: 'Doe',
      email: 'maya@example.com',
      phone: null,
    });

    await repository.createBooking({
      client_id: client.id,
      event_id: null,
      session_type_id: 'session-1',
      booking_type: 'PAY_LATER',
      starts_at: '2026-03-20T10:00:00.000Z',
      ends_at: '2026-03-20T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      google_event_id: null,
      address_line: 'A',
      maps_url: 'https://maps.example',
      price: 100,
      currency: 'CHF',
      coupon_code: null,
      current_status: 'CONFIRMED',
      notes: null,
    });
    await repository.createBooking({
      client_id: client.id,
      event_id: 'event-1',
      session_type_id: null,
      booking_type: 'FREE',
      starts_at: '2026-03-21T10:00:00.000Z',
      ends_at: '2026-03-21T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      google_event_id: null,
      address_line: 'A',
      maps_url: 'https://maps.example',
      price: 0,
      currency: 'CHF',
      coupon_code: null,
      current_status: 'NO_SHOW',
      notes: null,
    });
    await repository.createBooking({
      client_id: client.id,
      event_id: null,
      session_type_id: 'session-2',
      booking_type: 'PAY_LATER',
      starts_at: '2026-03-22T10:00:00.000Z',
      ends_at: '2026-03-22T11:00:00.000Z',
      timezone: 'Europe/Zurich',
      google_event_id: null,
      address_line: 'A',
      maps_url: 'https://maps.example',
      price: 100,
      currency: 'CHF',
      coupon_code: null,
      current_status: 'PENDING',
      notes: null,
    });

    const row = await repository.getAdminClientRowById(client.id);

    expect(row).toEqual(expect.objectContaining({
      sessions_count: 1,
      events_count: 1,
      last_session_at: '2026-03-20T10:00:00.000Z',
      last_event_at: '2026-03-21T10:00:00.000Z',
    }));
  });
});
