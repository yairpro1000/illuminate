import type { AppContext } from '../src/router.js';
import type { Env } from '../src/env.js';
import { createOperationContext } from '../src/lib/execution.js';
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
    OBSERVABILITY_SCHEMA: 'observability',
    SUPABASE_URL: 'https://supabase.local',
    SUPABASE_SECRET_KEY: 'x',
    RESEND_API_KEY: 'x',
    GOOGLE_CALENDAR_ID: 'x',
    GOOGLE_CLIENT_CALENDAR: 'x',
    GOOGLE_CLIENT_SECRET_CALENDAR: 'x',
    GOOGLE_REFRESH_TOKEN_CALENDAR: 'x',
    GOOGLE_CLIENT_EMAIL: 'x',
    GOOGLE_PRIVATE_KEY: 'x',
    GOOGLE_TOKEN_URI: 'x',
    TIMEZONE: 'Europe/Zurich',
    STRIPE_SECRET_KEY: 'x',
    STRIPE_WEBHOOK_SECRET: 'x',
    STRIPE_PUBLISHABLE_KEY: 'x',
    TURNSTILE_SECRET_KEY: 'x',
    JOB_SECRET: 'x',
    IMAGES_BUCKET: { put: vi.fn().mockResolvedValue(undefined) },
    IMAGE_BASE_URL: 'https://assets.example.com',
    GOOGLE_DRIVE_FOLDER_ID: undefined,
    GOOGLE_SERVICE_ACCOUNT_JSON: undefined,
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
  return {
    providers: {
      repository: {},
      email: {},
      calendar: {},
      payments: {},
      antibot: {},
      ...((partial as any).providers || {}),
    } as any,
    env: makeEnv((partial as any).env || {}),
    logger: makeLogger((partial as any).logger || {}),
    requestId: 'req-1',
    correlationId: 'corr-1',
    operation: createOperationContext({ requestId: 'req-1', correlationId: 'corr-1' }),
    executionCtx: undefined,
    ...partial,
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
