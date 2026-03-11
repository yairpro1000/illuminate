import { describe, expect, it, vi } from 'vitest';
import { createProviders } from '../src/providers/index.js';

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
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_SECRET_KEY: 'secret',
    RESEND_API_KEY: 'resend-secret',
    GOOGLE_CALENDAR_ID: 'calendar@example.com',
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
    logProviderCall: vi.fn(),
  } as any;
}

describe('provider observability wrapper', () => {
  it('suppresses repository success logs but keeps repository failure logs', async () => {
    const logger = makeLogger();
    const providers = createProviders(makeEnv(), logger);

    await providers.repository.createClient({
      first_name: 'Repo',
      last_name: 'Success',
      email: 'repo-success@example.com',
      phone: null,
    });

    expect(logger.logProviderCall).not.toHaveBeenCalled();

    await expect(
      providers.repository.updateBooking('missing-booking-id', { notes: 'x' }),
    ).rejects.toThrow();

    expect(logger.logProviderCall).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'repository',
      operation: 'updateBooking',
      success: false,
    }));
  });

  it('keeps success logs for non-repository providers', async () => {
    const logger = makeLogger();
    const providers = createProviders(makeEnv(), logger);

    await providers.email.sendContactMessage(
      'Test User',
      'user@example.com',
      'hello',
      'test_topic',
    );

    expect(logger.logProviderCall).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'email',
      operation: 'sendContactMessage',
      success: true,
    }));
  });
});

