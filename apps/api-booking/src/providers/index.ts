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
import { MockAntiBotProvider } from './antibot/mock.js';
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
  if (paymentsMode === 'stripe') {
    // const { StripePaymentsProvider } = await import('./payments/stripe.js');
    // payments = new StripePaymentsProvider(env.STRIPE_SECRET_KEY);
    throw new Error('Stripe payments are intentionally mocked in this dev-stage worker.');
  } else {
    payments = new MockPaymentsProvider(env.SITE_URL);
  }

  // antibot
  let antibot: IAntiBotProvider;
  if (antibotMode === 'turnstile') {
    // const { TurnstileAntiBotProvider } = await import('./antibot/turnstile.js');
    // antibot = new TurnstileAntiBotProvider(env.TURNSTILE_SECRET_KEY);
    throw new Error('Turnstile verification is intentionally mocked in this dev-stage worker.');
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
