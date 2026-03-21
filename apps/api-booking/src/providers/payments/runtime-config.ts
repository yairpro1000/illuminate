import type { Env } from '../../env.js';

export type PaymentsMode = 'mock' | 'stripe_sandbox' | 'stripe';

export interface StripeRuntimeConfig {
  mode: Extract<PaymentsMode, 'stripe_sandbox' | 'stripe'>;
  secretKey: string;
  webhookSecret: string;
  publishableKey: string | null;
}

export function normalizePaymentsMode(mode: string | null | undefined): PaymentsMode {
  if (mode === 'stripe_sandbox') return 'stripe_sandbox';
  if (mode === 'stripe') return 'stripe';
  return 'mock';
}

export function resolveStripeRuntimeConfig(
  env: Pick<
    Env,
    | 'STRIPE_SECRET_KEY'
    | 'STRIPE_WEBHOOK_SECRET'
    | 'STRIPE_PUBLISHABLE_KEY'
    | 'STRIPE_SECRET_KEY_SANDBOX'
    | 'STRIPE_WEBHOOK_SECRET_SANDBOX'
    | 'STRIPE_PUBLISHABLE_KEY_SANDBOX'
  >,
  paymentsMode: string | null | undefined,
): StripeRuntimeConfig | null {
  const normalizedMode = normalizePaymentsMode(paymentsMode);
  if (normalizedMode === 'mock') return null;

  if (normalizedMode === 'stripe_sandbox') {
    return {
      mode: normalizedMode,
      secretKey: env.STRIPE_SECRET_KEY_SANDBOX ?? '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET_SANDBOX ?? '',
      publishableKey: env.STRIPE_PUBLISHABLE_KEY_SANDBOX ?? null,
    };
  }

  return {
    mode: normalizedMode,
    secretKey: env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
    publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
  };
}
