import type { Env } from '../env.js';
import type { IRepository } from './repository/interface.js';
import type { IEmailProvider } from './email/interface.js';
import type { ICalendarProvider } from './calendar/interface.js';
import type { IPaymentsProvider } from './payments/interface.js';
import type { IAntiBotProvider } from './antibot/interface.js';

import { MockRepository } from './repository/mock.js';
import { MockEmailProvider } from './email/mock.js';
import { MockCalendarProvider } from './calendar/mock.js';
import { MockPaymentsProvider } from './payments/mock.js';
import { MockAntiBotProvider } from './antibot/mock.js';

export interface Providers {
  repository: IRepository;
  email:      IEmailProvider;
  calendar:   ICalendarProvider;
  payments:   IPaymentsProvider;
  antibot:    IAntiBotProvider;
}

// Singletons — created once per isolate lifetime
let _mockRepository: MockRepository | null = null;

function getMockRepository(): MockRepository {
  if (!_mockRepository) _mockRepository = new MockRepository();
  return _mockRepository;
}

export function createProviders(env: Env): Providers {
  // Each provider is switched independently via its own env var.
  // Set e.g. EMAIL_MODE=resend in wrangler.toml while keeping the rest as mock.

  // repository
  let repository: IRepository;
  if (env.REPOSITORY_MODE === 'supabase') {
    // const { SupabaseRepository } = await import('./repository/supabase.js');
    // repository = new SupabaseRepository(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    throw new Error('Supabase repository not yet implemented.');
  } else {
    repository = getMockRepository();
  }

  // email
  let email: IEmailProvider;
  if (env.EMAIL_MODE === 'resend') {
    // const { ResendEmailProvider } = await import('./email/resend.js');
    // email = new ResendEmailProvider(env.RESEND_API_KEY);
    throw new Error('Resend email provider not yet implemented.');
  } else {
    email = new MockEmailProvider();
  }

  // calendar
  let calendar: ICalendarProvider;
  if (env.CALENDAR_MODE === 'google') {
    // const { GoogleCalendarProvider } = await import('./calendar/google.js');
    // calendar = new GoogleCalendarProvider(env);
    throw new Error('Google Calendar provider not yet implemented.');
  } else {
    calendar = new MockCalendarProvider();
  }

  // payments
  let payments: IPaymentsProvider;
  if (env.PAYMENTS_MODE === 'stripe') {
    // const { StripePaymentsProvider } = await import('./payments/stripe.js');
    // payments = new StripePaymentsProvider(env.STRIPE_SECRET_KEY);
    throw new Error('Stripe payments provider not yet implemented.');
  } else {
    payments = new MockPaymentsProvider(env.SITE_URL);
  }

  // antibot
  let antibot: IAntiBotProvider;
  if (env.ANTIBOT_MODE === 'turnstile') {
    // const { TurnstileAntiBotProvider } = await import('./antibot/turnstile.js');
    // antibot = new TurnstileAntiBotProvider(env.TURNSTILE_SECRET_KEY);
    throw new Error('Turnstile antibot provider not yet implemented.');
  } else {
    antibot = new MockAntiBotProvider();
  }

  return { repository, email, calendar, payments, antibot };
}
