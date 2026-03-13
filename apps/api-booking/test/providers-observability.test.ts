import { describe, expect, it, vi } from 'vitest';

const updateEq = vi.fn().mockResolvedValue({ error: null });
const update = vi.fn().mockReturnValue({ eq: updateEq });
const selectSingle = vi.fn().mockResolvedValue({ data: { id: 'api-log-1' }, error: null });
const select = vi.fn().mockReturnValue({ single: selectSingle });
const insert = vi.fn().mockReturnValue({ select });

vi.mock('../src/repo/supabase.js', () => ({
  makeSupabase: vi.fn(() => ({
    schema: vi.fn(() => ({
      from: vi.fn(() => ({
        insert,
        update,
      })),
    })),
  })),
}));
import { createProviders } from '../src/providers/index.js';
import { createOperationContext } from '../src/lib/execution.js';
import {
  recordExceptionLog,
  wrapProvidersForOperation,
} from '../src/lib/technical-observability.js';

function makeEnv() {
  return {
    REPOSITORY_MODE: 'mock',
    EMAIL_MODE: 'mock',
    CALENDAR_MODE: 'mock',
    PAYMENTS_MODE: 'mock',
    ANTIBOT_MODE: 'mock',
    SITE_URL: 'https://example.com',
    SESSION_ADDRESS: 'Somewhere 1',
    SESSION_MAPS_URL: 'https://maps.example',
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SECRET_KEY: 'secret',
    OBSERVABILITY_SCHEMA: 'observability',
    RESEND_API_KEY: 'resend-secret',
    GOOGLE_CALENDAR_ID: 'calendar@example.com',
    GOOGLE_CLIENT_CALENDAR: 'client-id',
    GOOGLE_CLIENT_SECRET_CALENDAR: 'client-secret',
    GOOGLE_REFRESH_TOKEN_CALENDAR: 'refresh-token',
    GOOGLE_CLIENT_EMAIL: 'service@example.com',
    GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    GOOGLE_TOKEN_URI: 'https://oauth2.googleapis.com/token',
    TIMEZONE: 'Europe/Zurich',
    STRIPE_SECRET_KEY: 'stripe-secret',
    STRIPE_WEBHOOK_SECRET: 'whsec',
    STRIPE_PUBLISHABLE_KEY: 'pk_test',
    TURNSTILE_SECRET_KEY: 'turnstile',
    JOB_SECRET: 'job-secret',
    IMAGES_BUCKET: {} as R2Bucket,
  } as any;
}

function makeLogger() {
  return {
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  } as any;
}

describe('provider observability wrapper', () => {
  it('wraps only external providers and leaves repository calls outside the outbound wrapper', async () => {
    insert.mockClear();
    updateEq.mockClear();
    const logger = makeLogger();
    const operation = createOperationContext({ appArea: 'website', requestId: 'req-1', correlationId: 'corr-1' });
    const providers = wrapProvidersForOperation(createProviders(makeEnv(), logger), makeEnv(), logger, operation);

    await providers.repository.createClient({
      first_name: 'Repo',
      last_name: 'Only',
      email: 'repo@example.com',
      phone: null,
    });

    expect(logger.logInfo).not.toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'provider_wrapper_started',
      context: expect.objectContaining({
        provider: 'repository',
      }),
    }));
  });

  it('routes external provider calls through the shared outbound wrapper', async () => {
    insert.mockClear();
    updateEq.mockClear();
    const logger = makeLogger();
    const env = makeEnv();
    const operation = createOperationContext({ appArea: 'website', requestId: 'req-1', correlationId: 'corr-1' });
    const providers = wrapProvidersForOperation(createProviders(env, logger), env, logger, operation);

    await providers.email.sendContactMessage(
      'Test User',
      'user@example.com',
      'hello',
      'test_topic',
    );

    expect(logger.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'provider_wrapper_started',
      context: expect.objectContaining({
        provider: 'email',
        provider_operation: 'sendContactMessage',
        branch_taken: 'execute_provider_call_via_shared_wrapper',
      }),
    }));
    expect(operation.latestProviderApiLogId).toBe('api-log-1');
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      app_area: 'website',
      direction: 'outbound',
    }));
    expect(updateEq).toHaveBeenCalledWith('id', 'api-log-1');
  });

  it('writes app_area on exception log inserts from the wrapper context', async () => {
    insert.mockClear();
    const env = makeEnv();
    const operation = createOperationContext({ appArea: 'admin', requestId: 'req-2', correlationId: 'corr-2' });

    await recordExceptionLog(env, operation, new Error('boom'), { path: '/api/admin/bookings' }, 'INTERNAL_ERROR');

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      app_area: 'admin',
      request_id: 'req-2',
      correlation_id: 'corr-2',
      error_code: 'INTERNAL_ERROR',
    }));
  });
});
