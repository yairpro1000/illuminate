import type { Env } from '../env.js';
import type { IRepository } from './repository/interface.js';
import type { IEmailProvider } from './email/interface.js';
import type { ICalendarProvider } from './calendar/interface.js';
import type { IPaymentsProvider } from './payments/interface.js';
import type { IAntiBotProvider } from './antibot/interface.js';
import type { Logger } from '../lib/logger.js';
import { getOverride } from '../lib/config-overrides.js';

import { MockRepository } from './repository/mock.js';
import { SupabaseRepository } from './repository/supabase.js';
import { MockEmailProvider } from './email/mock.js';
import { ResendEmailProvider } from './email/resend.js';
import { MockCalendarProvider } from './calendar/mock.js';
import { GoogleCalendarProvider } from './calendar/google.js';
import { MockPaymentsProvider } from './payments/mock.js';
import { StripePaymentsProvider } from './payments/stripe.js';
import { normalizePaymentsMode, resolveStripeRuntimeConfig } from './payments/runtime-config.js';
import { MockAntiBotProvider } from './antibot/mock.js';
import { TurnstileAntiBotProvider } from './antibot/turnstile.js';
import { makeSupabase } from '../repo/supabase.js';

export interface Providers {
  repository: IRepository;
  email:      IEmailProvider;
  calendar:   ICalendarProvider;
  payments:   IPaymentsProvider;
  antibot:    IAntiBotProvider;
}

// Singletons — created once per isolate lifetime
let _mockRepository: MockRepository | null = null;
let _supabaseRepository: SupabaseRepository | null = null;

function getMockRepository(): MockRepository {
  if (!_mockRepository) _mockRepository = new MockRepository();
  return _mockRepository;
}

function getSupabaseRepository(env: Env): SupabaseRepository {
  if (!_supabaseRepository) {
    _supabaseRepository = new SupabaseRepository(makeSupabase(env));
  }
  return _supabaseRepository;
}

export function createProviders(env: Env, logger?: Logger): Providers {
  // Each provider is switched independently via its own env var.
  // Set e.g. EMAIL_MODE=resend in wrangler.toml while keeping the rest as mock.

  // Resolve effective modes: runtime override takes precedence over env var.
  const repoMode     = getOverride('repository') ?? env.REPOSITORY_MODE;
  const emailMode    = getOverride('email')      ?? env.EMAIL_MODE;
  const calendarMode = getOverride('calendar')   ?? env.CALENDAR_MODE;
  const paymentsMode = getOverride('payments')   ?? env.PAYMENTS_MODE;
  const antibotMode  = getOverride('antibot')    ?? env.ANTIBOT_MODE;

  // repository
  let repository: IRepository;
  if (repoMode === 'supabase') {
    repository = getSupabaseRepository(env);
  } else {
    repository = getMockRepository();
  }

  // email
  let email: IEmailProvider;
  if (emailMode === 'resend') {
    email = new ResendEmailProvider(env.RESEND_API_KEY);
  } else {
    email = new MockEmailProvider();
  }

  // calendar
  let calendar: ICalendarProvider;
  if (calendarMode === 'google') {
    calendar = new GoogleCalendarProvider(env, logger);
  } else {
    calendar = new MockCalendarProvider();
  }

  // payments
  let payments: IPaymentsProvider;
  const normalizedPaymentsMode = normalizePaymentsMode(paymentsMode);
  const stripeRuntimeConfig = resolveStripeRuntimeConfig(env, paymentsMode);
  logger?.logInfo?.({
    source: 'backend',
    eventType: 'payments_provider_mode_decision',
    message: 'Evaluated payments provider mode',
    context: {
      payments_mode_env: env.PAYMENTS_MODE,
      payments_mode_override: getOverride('payments') ?? null,
      payments_mode_effective: normalizedPaymentsMode,
      stripe_runtime_mode: stripeRuntimeConfig?.mode ?? null,
      stripe_secret_present: Boolean(stripeRuntimeConfig?.secretKey),
      stripe_webhook_secret_present: Boolean(stripeRuntimeConfig?.webhookSecret),
      branch_taken: normalizedPaymentsMode === 'mock'
        ? 'select_mock_payments_provider'
        : 'select_stripe_payments_provider',
      deny_reason: null,
    },
  });
  if (stripeRuntimeConfig) {
    payments = new StripePaymentsProvider(stripeRuntimeConfig.secretKey, env.SITE_URL);
  } else {
    payments = new MockPaymentsProvider(env.SITE_URL);
  }
  logger?.logInfo?.({
    source: 'backend',
    eventType: 'payments_provider_mode_selected',
    message: 'Selected payments provider implementation',
    context: {
      payments_mode_effective: normalizedPaymentsMode,
      stripe_runtime_mode: stripeRuntimeConfig?.mode ?? null,
      provider_class: stripeRuntimeConfig ? 'StripePaymentsProvider' : 'MockPaymentsProvider',
      branch_taken: stripeRuntimeConfig
        ? 'payments_provider_selected_stripe'
        : 'payments_provider_selected_mock',
      deny_reason: null,
    },
  });

  // antibot
  let antibot: IAntiBotProvider;
  if (antibotMode === 'turnstile') {
    antibot = new TurnstileAntiBotProvider(
      env.TURNSTILE_SECRET_KEY || env.TURNSTILE_TEST_SECRET_KEY_PASS || '',
      logger,
    );
  } else {
    antibot = new MockAntiBotProvider();
  }

  return {
    repository,
    email,
    calendar,
    payments,
    antibot,
  };
}
