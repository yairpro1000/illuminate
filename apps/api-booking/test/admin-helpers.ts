import type { AppContext } from '../src/router.js';
import type { Env } from '../src/env.js';
import { createOperationContext } from '../src/lib/execution.js';
import { MockRepository } from '../src/providers/repository/mock.js';
import { vi } from 'vitest';

export function makeEnv(overrides: Partial<Env> = {}): Env {
  const base: any = {
    REPOSITORY_MODE: 'mock',
    EMAIL_MODE: 'mock',
    CALENDAR_MODE: 'mock',
    PAYMENTS_MODE: 'mock',
    ANTIBOT_MODE: 'mock',
    SITE_URL: 'https://example.com',
    SESSION_ADDRESS: 'Somewhere 1, Zurich',
    SESSION_MAPS_URL: 'https://maps.example',
    API_ALLOWED_ORIGINS: '*',
    ADMIN_ALLOWED_EMAILS: 'admin@example.com',
    ADMIN_DEV_EMAIL: '',
    OBSERVABILITY_SCHEMA: 'public',
    SUPABASE_URL: 'https://supabase.local',
    SUPABASE_SECRET_KEY: 'x',
    RESEND_API_KEY: 'x',
    GOOGLE_CALENDAR_ID: 'x',
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: 'service-account@example.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
    TIMEZONE: 'Europe/Zurich',
    STRIPE_SECRET_KEY: 'x',
    STRIPE_WEBHOOK_SECRET: 'x',
    STRIPE_PUBLISHABLE_KEY: 'x',
    TURNSTILE_SECRET_KEY: 'x',
    TURNSTILE_SITE_KEY: 'site-key-live',
    TURNSTILE_TEST_SITE_KEY_PASS: 'site-key-pass',
    TURNSTILE_TEST_SITE_KEY_ALWAYS_FAIL: 'site-key-fail',
    TURNSTILE_TEST_SECRET_KEY_PASS: 'secret-key-pass',
    TURNSTILE_TEST_SECRET_KEY_ALWAYS_FAIL: 'secret-key-fail',
    JOB_SECRET: 'x',
    IMAGES_BUCKET: { put: vi.fn().mockResolvedValue(undefined) },
    IMAGE_BASE_URL: 'https://assets.example.com',
    GOOGLE_DRIVE_FOLDER_ID: undefined,
  };
  return { ...base, ...overrides } as Env;
}

export function makeLogger(overrides: any = {}) {
  return {
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    captureException: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logRequest: vi.fn(),
    logMilestone: vi.fn(),
    ...overrides,
  } as any;
}

export function makeCtx(partial: Partial<AppContext> = {}): AppContext {
  const baseRepository = new MockRepository();
  const providerOverrides = ((partial as any).providers || {}) as Record<string, unknown>;
  const repository = Object.assign(baseRepository, providerOverrides.repository as Record<string, unknown> | undefined);
  const { repository: _repositoryOverride, ...otherProviderOverrides } = providerOverrides;
  const { providers: _providers, ...restPartial } = partial as Record<string, unknown>;
  return {
    providers: {
      repository,
      email: {},
      calendar: {},
      payments: {},
      antibot: {},
      ...otherProviderOverrides,
    } as any,
    env: makeEnv((partial as any).env || {}),
    logger: makeLogger((partial as any).logger || {}),
    requestId: 'req-1',
    correlationId: 'corr-1',
    operation: createOperationContext({ appArea: 'website', requestId: 'req-1', correlationId: 'corr-1' }),
    executionCtx: undefined,
    ...(restPartial as Partial<AppContext>),
  } as AppContext;
}

export function adminRequest(method: string, path: string, body?: any): Request {
  const url = new URL(path, 'https://api.local');
  const init: any = { method, headers: { 'Cf-Access-Authenticated-User-Email': 'admin@example.com' } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  return new Request(url.toString(), init);
}
