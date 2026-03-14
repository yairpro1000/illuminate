/**
 * Runtime provider-mode overrides.
 *
 * These override the corresponding *_MODE env vars for the lifetime of the
 * isolate (reset on cold start / redeploy). Intended for dev/admin use only.
 */

export type ServiceKey = 'repository' | 'email' | 'calendar' | 'payments' | 'antibot';

export interface ModeDefinition {
  value: string;
  label: string;
  /** false = the real provider is not yet wired — switching to it will throw */
  wired: boolean;
}

export interface ServiceDefinition {
  key: ServiceKey;
  label: string;
  modes: ModeDefinition[];
}

/** Authoritative catalog of all provider services and their available modes. */
export const SERVICE_MODES: ServiceDefinition[] = [
  {
    key: 'email',
    label: 'Email',
    modes: [
      { value: 'mock', label: 'Mock (console)', wired: true },
      { value: 'resend', label: 'Resend', wired: true },
    ],
  },
  {
    key: 'calendar',
    label: 'Calendar',
    modes: [
      { value: 'mock', label: 'Mock (generated)', wired: true },
      { value: 'google', label: 'Google Calendar', wired: true },
    ],
  },
  {
    key: 'repository',
    label: 'Repository',
    modes: [
      { value: 'mock', label: 'Mock (in-memory)', wired: true },
      { value: 'supabase', label: 'Supabase', wired: false }, // flip to true when SupabaseRepository class is wired in providers/index.ts
    ],
  },
  {
    key: 'payments',
    label: 'Payments',
    modes: [
      { value: 'mock', label: 'Mock (simulated)', wired: true },
      { value: 'stripe', label: 'Stripe', wired: false }, // flip to true when wired in providers/index.ts
    ],
  },
  {
    key: 'antibot',
    label: 'Anti-bot',
    modes: [
      { value: 'mock', label: 'Mock (bypass)', wired: true },
      { value: 'turnstile', label: 'Turnstile', wired: true },
    ],
  },
];

const overrides = new Map<ServiceKey, string>();

export function getOverride(key: ServiceKey): string | undefined {
  return overrides.get(key);
}

export function setOverride(key: ServiceKey, mode: string): void {
  overrides.set(key, mode);
}

export function clearOverride(key: ServiceKey): void {
  overrides.delete(key);
}

export function getAllOverrides(): Partial<Record<ServiceKey, string>> {
  return Object.fromEntries(overrides.entries());
}
