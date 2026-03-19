import { describe, expect, it } from 'vitest';
import { normalizePaymentsMode, resolveStripeRuntimeConfig } from '../src/providers/payments/runtime-config.js';

const env = {
  STRIPE_SECRET_KEY: 'sk_live_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_live_123',
  STRIPE_PUBLISHABLE_KEY: 'pk_live_123',
  STRIPE_SECRET_KEY_SANDBOX: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET_SANDBOX: 'whsec_test_123',
  STRIPE_PUBLISHABLE_KEY_SANDBOX: 'pk_test_123',
} as const;

describe('payments runtime config', () => {
  it('normalizes unknown payment modes back to mock', () => {
    expect(normalizePaymentsMode(undefined)).toBe('mock');
    expect(normalizePaymentsMode('unexpected')).toBe('mock');
  });

  it('resolves production Stripe credentials for stripe mode', () => {
    expect(resolveStripeRuntimeConfig(env as any, 'stripe')).toEqual({
      mode: 'stripe',
      secretKey: 'sk_live_123',
      webhookSecret: 'whsec_live_123',
      publishableKey: 'pk_live_123',
    });
  });

  it('resolves sandbox Stripe credentials for stripe_sandbox mode', () => {
    expect(resolveStripeRuntimeConfig(env as any, 'stripe_sandbox')).toEqual({
      mode: 'stripe_sandbox',
      secretKey: 'sk_test_123',
      webhookSecret: 'whsec_test_123',
      publishableKey: 'pk_test_123',
    });
  });

  it('returns null for mock mode', () => {
    expect(resolveStripeRuntimeConfig(env as any, 'mock')).toBeNull();
  });
});
