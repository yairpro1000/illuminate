import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const SITE_BASE_URL = process.env.E2E_SITE_BASE_URL || 'https://illuminate-tw9.pages.dev';
export const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || 'https://illuminateadmin.pages.dev';
export const API_BASE_URL = process.env.E2E_API_BASE_URL || 'https://illuminate.yairpro.workers.dev';

type ServiceKey = 'repository' | 'email' | 'calendar' | 'payments' | 'antibot';

interface AdminConfigService {
  key: ServiceKey;
  effective_mode: string;
  env_mode: string;
  override_mode: string | null;
}

interface AdminTimingSetting {
  domain: string;
  keyname: string;
  readable_name: string;
  value_type: string;
  unit: string | null;
  value: string;
  description: string;
  description_he: string | null;
}

export interface BookingArtifacts {
  client: {
    id: string;
    email: string;
  };
  booking: {
    id: string;
    source: 'event' | 'session';
    status: string;
    event_id: string | null;
    session_type_id: string | null;
    starts_at: string;
    ends_at: string;
    timezone: string;
  };
  links: {
    confirm_url: string | null;
    manage_url: string;
  };
  payment: null | {
    id: string;
    status: string;
    session_id: string | null;
    checkout_url: string | null;
    invoice_url: string | null;
    receipt_url: string | null;
    credit_note_url: string | null;
    refund_status: string | null;
    refunded_at: string | null;
    refund_amount: number | null;
    refund_currency: string | null;
    stripe_invoice_id: string | null;
    stripe_refund_id: string | null;
    stripe_credit_note_id: string | null;
  };
  events: Array<{
    id: string;
    event_type: string;
    source: string;
    payload: Record<string, unknown>;
    created_at: string;
    side_effects: Array<{
      id: string;
      entity: string;
      effect_intent: string;
      status: string;
      expires_at: string | null;
      max_attempts: number;
      created_at: string;
      updated_at: string;
      attempts: Array<{
        id: string;
        attempt_num: number;
        status: string;
        error_message: string | null;
        api_log_id: string | null;
        created_at: string;
      }>;
    }>;
  }>;
}

export interface PublicSlot {
  type: 'intro' | 'session';
  start: string;
  end: string;
}

export interface AdminSessionTypeAvailabilityWindow {
  id: string;
  session_type_id: string;
  weekday_iso: number;
  start_local_time: string;
  end_local_time: string;
  sort_order: number;
  active: boolean;
}

export interface AdminSessionTypeWeekSummary {
  week_start_date: string;
  week_end_exclusive_date: string;
  mode: 'AUTO' | 'FORCE_OPEN' | 'FORCE_CLOSED';
  override_weekly_booking_limit: number | null;
  effective_weekly_booking_limit: number | null;
  active_booking_count: number;
  remaining_capacity: number | null;
  branch_taken: string;
  deny_reason: string | null;
  note: string | null;
  updated_by: string | null;
}

export interface AdminSessionTypeDetail {
  session_type: Record<string, any>;
  availability: {
    mode: 'shared_default' | 'dedicated';
    timezone: string;
    weekly_booking_limit: number | null;
    slot_step_minutes: number | null;
    windows: AdminSessionTypeAvailabilityWindow[];
    upcoming_weeks: AdminSessionTypeWeekSummary[];
  };
}

export interface CapturedEmailSummary {
  id: string;
  to: string;
  subject: string;
  kind: string;
  sentAt: string;
  has_html: boolean;
  preview_url: string;
  preview_html_url: string;
}

export interface MockEmailPreviewPayload {
  email_id: string;
  to: string;
  subject: string;
  html_url: string;
  html_content: string;
  email_kind: string;
}

export interface SupabasePaymentRow {
  id: string;
  booking_id: string;
  status: string;
  provider: string;
  stripe_customer_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  stripe_payment_link_id: string | null;
  invoice_url: string | null;
  checkout_url: string | null;
  paid_at: string | null;
  amount: number | null;
  currency: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupabaseBookingRow {
  id: string;
  price: number | null;
  currency: string | null;
  coupon_code: string | null;
  created_at: string;
  updated_at: string;
}

let cachedSupabaseEnv: { url: string; secretKey: string } | null = null;

function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseRepoEnvFile(): Record<string, string> {
  const envUrl = new URL('../../../../.env', import.meta.url);
  if (!existsSync(envUrl)) return {};

  const parsed: Record<string, string> = {};
  const text = readFileSync(envUrl, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    parsed[match[1]] = stripOptionalQuotes(match[2]);
  }
  return parsed;
}

function getSupabaseEnv(): { url: string; secretKey: string } {
  if (cachedSupabaseEnv) return cachedSupabaseEnv;

  const fileEnv = parseRepoEnvFile();
  const url = process.env.SUPABASE_URL || fileEnv.SUPABASE_URL || '';
  const secretKey = process.env.SUPABASE_SECRET_KEY || fileEnv.SUPABASE_SECRET_KEY || '';
  if (!url || !secretKey) {
    throw new Error('Supabase credentials are required for direct payment-table verification.');
  }

  cachedSupabaseEnv = { url, secretKey };
  return cachedSupabaseEnv;
}

export function makeScenarioEmail(prefix: string): string {
  const forcedEmail = process.env.E2E_CUSTOMER_EMAIL?.trim();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (forcedEmail) {
    const atIndex = forcedEmail.indexOf('@');
    if (atIndex > 0) {
      const local = forcedEmail.slice(0, atIndex).replace(/\+.*/, '');
      const domain = forcedEmail.slice(atIndex + 1);
      return `${local}+${prefix}-${suffix}@${domain}`;
    }
    return forcedEmail;
  }
  return `${prefix}-${suffix}@example.test`;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new Error(`${init?.method || 'GET'} ${path} -> ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  return body as T;
}

async function adminJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  headers.set('Cf-Access-Authenticated-User-Email', 'admin@example.com');
  return apiJson<T>(path, { ...init, headers });
}

export async function getSlots(
  from: string,
  to: string,
  type: 'intro' | 'session',
  tz = 'Europe/Zurich',
  options?: { offerSlug?: string; sessionTypeId?: string },
): Promise<PublicSlot[]> {
  const params = new URLSearchParams({ from, to, type, tz });
  if (options?.offerSlug) params.set('offer_slug', options.offerSlug);
  if (options?.sessionTypeId) params.set('session_type_id', options.sessionTypeId);
  const data = await apiJson<{ slots: PublicSlot[] }>(`/api/slots?${params.toString()}`);
  return Array.isArray(data.slots) ? data.slots : [];
}

export async function createPayNowBookingForSlot(
  slot: PublicSlot,
  email: string,
  options?: { offerSlug?: string },
): Promise<{ booking_id: string; checkout_url: string | null; checkout_hold_expires_at: string | null }> {
  return apiJson('/api/bookings/pay-now', {
    method: 'POST',
    body: JSON.stringify({
      slot_start: slot.start,
      slot_end: slot.end,
      type: slot.type,
      offer_slug: options?.offerSlug || null,
      timezone: 'Europe/Zurich',
      first_name: 'P4',
      last_name: 'E2E',
      client_email: email,
      client_phone: '+41790000000',
      turnstile_token: 'ok',
    }),
  });
}

export async function createPayLaterBookingForSlot(
  slot: PublicSlot,
  email: string,
  options?: { offerSlug?: string },
): Promise<{ booking_id: string; status: string }> {
  return apiJson('/api/bookings/pay-later', {
    method: 'POST',
    body: JSON.stringify({
      slot_start: slot.start,
      slot_end: slot.end,
      type: slot.type,
      offer_slug: options?.offerSlug || null,
      timezone: 'Europe/Zurich',
      first_name: 'P4',
      last_name: 'E2E',
      client_email: email,
      client_phone: '+41790000000',
      turnstile_token: 'ok',
    }),
  });
}

export async function simulatePaymentSuccess(sessionId: string): Promise<void> {
  await apiJson(`/api/__dev/simulate-payment?session_id=${encodeURIComponent(sessionId)}&result=success`, {
    method: 'POST',
  });
}

export async function cancelBookingByManageUrl(manageUrl: string): Promise<void> {
  const url = new URL(manageUrl);
  const token = url.searchParams.get('token');
  const adminToken = url.searchParams.get('admin_token');
  if (!token) throw new Error('Manage URL is missing token');

  await apiJson('/api/bookings/cancel', {
    method: 'POST',
    body: JSON.stringify({
      token,
      ...(adminToken ? { admin_token: adminToken } : {}),
    }),
  });
}

export async function getEvents(): Promise<Array<Record<string, any>>> {
  const data = await apiJson<{ events: Array<Record<string, any>> }>('/api/events');
  return Array.isArray(data.events) ? data.events : [];
}

export async function getSessionTypes(): Promise<Array<Record<string, any>>> {
  const data = await apiJson<{ session_types: Array<Record<string, any>> }>('/api/session-types');
  return Array.isArray(data.session_types) ? data.session_types : [];
}

export async function getAdminEventsAll(): Promise<Array<Record<string, any>>> {
  const data = await adminJson<{ events: Array<Record<string, any>> }>('/api/admin/events/all');
  return Array.isArray(data.events) ? data.events : [];
}

export async function updateAdminEvent(eventId: string, patch: Record<string, unknown>): Promise<Record<string, any>> {
  const data = await adminJson<{ event: Record<string, any> }>(`/api/admin/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return data.event;
}

export async function createLateAccessLink(eventId: string): Promise<{ url: string; expires_at: string }> {
  return adminJson(`/api/admin/events/${encodeURIComponent(eventId)}/late-access-links`, {
    method: 'POST',
  });
}

export async function getAdminTimingSettings(): Promise<AdminTimingSetting[]> {
  const data = await adminJson<{ timing_delays: { entries: AdminTimingSetting[] } }>('/api/admin/config');
  return Array.isArray(data.timing_delays?.entries) ? data.timing_delays.entries : [];
}

export async function updateAdminTimingSetting(keyname: string, value: string): Promise<void> {
  const settings = await getAdminTimingSettings();
  const existing = settings.find((entry) => entry.keyname === keyname);
  if (!existing) throw new Error(`Timing setting '${keyname}' not found`);
  await adminJson('/api/admin/config', {
    method: 'PATCH',
    body: JSON.stringify({
      original_keyname: existing.keyname,
      domain: existing.domain,
      keyname: existing.keyname,
      readable_name: existing.readable_name,
      value_type: existing.value_type,
      unit: existing.unit,
      value,
      description: existing.description,
      description_he: existing.description_he,
    }),
  });
}

export async function getAdminContactMessages(): Promise<Array<Record<string, any>>> {
  const data = await adminJson<{ rows: Array<Record<string, any>> }>('/api/admin/contact-messages');
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function createAdminSessionType(input: {
  title: string;
  slug: string;
  short_description?: string | null;
  description: string;
  duration_minutes: number;
  price: number;
  currency?: string;
  status?: string;
  sort_order?: number;
}): Promise<Record<string, any>> {
  const data = await adminJson<{ session_type: Record<string, any> }>('/api/admin/session-types', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      slug: input.slug,
      short_description: input.short_description ?? null,
      description: input.description,
      duration_minutes: input.duration_minutes,
      price: input.price,
      currency: input.currency ?? 'CHF',
      status: input.status ?? 'active',
      sort_order: input.sort_order ?? 0,
      image_key: null,
      image_alt: null,
      drive_file_id: null,
    }),
  });
  return data.session_type;
}

export async function updateAdminSessionType(
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, any>> {
  const data = await adminJson<{ session_type: Record<string, any> }>(`/api/admin/session-types/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return data.session_type;
}

export async function getAdminSessionTypeDetail(id: string): Promise<AdminSessionTypeDetail> {
  return adminJson<AdminSessionTypeDetail>(`/api/admin/session-types/${encodeURIComponent(id)}`);
}

export async function ensureAdminServiceMode(key: ServiceKey, mode: string): Promise<void> {
  const config = await adminJson<{ services: AdminConfigService[] }>('/api/admin/config');
  const service = Array.isArray(config.services) ? config.services.find((entry) => entry.key === key) : null;
  if (!service) throw new Error(`Admin config is missing service '${key}'`);
  if (service.effective_mode === mode) return;

  const updated = await adminJson<{ effective_mode: string }>('/api/admin/config', {
    method: 'PATCH',
    body: JSON.stringify({ key, mode }),
  });
  if (updated.effective_mode !== mode) {
    throw new Error(`Could not force ${key} mode to ${mode}. Effective mode is ${updated.effective_mode}`);
  }
}

export async function ensureEmailMock(): Promise<void> {
  await ensureAdminServiceMode('email', 'mock');
}

export async function ensureAntiBotMock(): Promise<void> {
  await ensureAdminServiceMode('antibot', 'mock');
}

export async function ensurePaymentsMock(): Promise<void> {
  await ensureAdminServiceMode('payments', 'mock');
}

export async function listCapturedEmails(): Promise<CapturedEmailSummary[]> {
  const data = await apiJson<{ emails: CapturedEmailSummary[] }>('/api/__dev/emails');
  return Array.isArray(data.emails) ? data.emails : [];
}

export async function waitForCapturedEmail(
  to: string,
  kind?: string,
  timeoutMs = 20_000,
): Promise<CapturedEmailSummary> {
  const deadline = Date.now() + timeoutMs;
  let lastEmails: CapturedEmailSummary[] = [];

  while (Date.now() < deadline) {
    lastEmails = await listCapturedEmails();
    const match = [...lastEmails]
      .reverse()
      .find((email) => email.to === to && (!kind || email.kind === kind));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Could not find captured email for ${to}${kind ? ` (${kind})` : ''}. Last seen: ${JSON.stringify(lastEmails)}`);
}

export async function fetchCapturedEmailPreviewHtml(previewHtmlUrl: string): Promise<string> {
  const response = await fetch(previewHtmlUrl);
  if (!response.ok) {
    throw new Error(`GET preview html -> ${response.status}: ${await response.text()}`);
  }
  return response.text();
}

export async function waitForBookingEventEmailPreview(
  input: {
    bookingId: string;
    bookingEventType: string;
    token: string;
    emailKind?: string;
  },
  timeoutMs = 20_000,
): Promise<MockEmailPreviewPayload> {
  const deadline = Date.now() + timeoutMs;
  let lastPreview: MockEmailPreviewPayload | null = null;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const params = new URLSearchParams({
        booking_id: input.bookingId,
        booking_event_type: input.bookingEventType,
        token: input.token,
      });
      const data = await apiJson<{ mock_email_preview?: MockEmailPreviewPayload }>(`/api/bookings/event-status?${params.toString()}`);
      const preview = data.mock_email_preview ?? null;
      lastPreview = preview;
      if (preview && (!input.emailKind || preview.email_kind === input.emailKind)) {
        return preview;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (lastPreview) {
    throw new Error(`Timed out waiting for ${input.bookingEventType} email preview (${input.emailKind || 'any'}). Last preview: ${JSON.stringify(lastPreview)}`);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${input.bookingEventType} email preview (${input.emailKind || 'any'})`);
}

export async function waitForBookingArtifacts(email: string): Promise<BookingArtifacts> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await apiJson<BookingArtifacts>(`/api/__test/booking-artifacts?email=${encodeURIComponent(email)}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not resolve booking artifacts');
}

export async function waitForBookingArtifactsWhere(
  email: string,
  predicate: (artifacts: BookingArtifacts) => boolean,
  timeoutMs = 20_000,
): Promise<BookingArtifacts> {
  const deadline = Date.now() + timeoutMs;
  let lastArtifacts: BookingArtifacts | null = null;

  while (Date.now() < deadline) {
    lastArtifacts = await waitForBookingArtifacts(email);
    if (predicate(lastArtifacts)) return lastArtifacts;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for booking artifacts predicate for ${email}. Last artifacts: ${JSON.stringify(lastArtifacts)}`);
}

export async function getSupabasePaymentRowByBookingId(bookingId: string): Promise<SupabasePaymentRow | null> {
  const { url, secretKey } = getSupabaseEnv();
  const params = new URLSearchParams({
    select: 'id,booking_id,status,provider,stripe_customer_id,stripe_checkout_session_id,stripe_payment_intent_id,stripe_invoice_id,stripe_payment_link_id,invoice_url,checkout_url,paid_at,amount,currency,created_at,updated_at',
    booking_id: `eq.${bookingId}`,
    order: 'created_at.desc',
    limit: '1',
  });

  const response = await fetch(`${url}/rest/v1/payments?${params.toString()}`, {
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET payments by booking_id -> ${response.status}: ${body}`);
  }

  const rows = JSON.parse(body) as SupabasePaymentRow[];
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

export async function getSupabaseBookingRowById(bookingId: string): Promise<SupabaseBookingRow | null> {
  const { url, secretKey } = getSupabaseEnv();
  const params = new URLSearchParams({
    select: 'id,price,currency,coupon_code,created_at,updated_at',
    id: `eq.${bookingId}`,
    limit: '1',
  });

  const response = await fetch(`${url}/rest/v1/bookings?${params.toString()}`, {
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET bookings by id -> ${response.status}: ${body}`);
  }

  const rows = JSON.parse(body) as SupabaseBookingRow[];
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

export async function waitForSupabaseBookingSnapshot(
  bookingId: string,
  predicate: (row: SupabaseBookingRow) => boolean,
  timeoutMs = 20_000,
): Promise<SupabaseBookingRow> {
  const deadline = Date.now() + timeoutMs;
  let lastRow: SupabaseBookingRow | null = null;

  while (Date.now() < deadline) {
    lastRow = await getSupabaseBookingRowById(bookingId);
    if (lastRow && predicate(lastRow)) return lastRow;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for Supabase booking snapshot for booking ${bookingId}. Last row: ${JSON.stringify(lastRow)}`);
}

export async function waitForSupabasePaymentStatus(
  bookingId: string,
  expectedStatuses: string | string[],
  timeoutMs = 20_000,
): Promise<SupabasePaymentRow> {
  const expected = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
  const deadline = Date.now() + timeoutMs;
  let lastRow: SupabasePaymentRow | null = null;

  while (Date.now() < deadline) {
    lastRow = await getSupabasePaymentRowByBookingId(bookingId);
    if (lastRow && expected.includes(lastRow.status)) return lastRow;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for Supabase payment status ${expected.join(', ')} for booking ${bookingId}. Last row: ${JSON.stringify(lastRow)}`);
}

export async function mutateTestBooking(input: {
  email: string;
  starts_at?: string;
  ends_at?: string;
  latest_submission_created_at?: string;
}): Promise<void> {
  await apiJson('/api/__test/bookings/mutate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function expireTestBooking(email: string): Promise<{ email: string; booking_id: string; status: string }> {
  return apiJson('/api/__test/bookings/expire', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function expectManageStatus(email: string, expectedStatus: string): Promise<BookingArtifacts> {
  const artifacts = await waitForBookingArtifacts(email);
  expect(artifacts.booking.status).toBe(expectedStatus);
  return artifacts;
}

export function findEventArtifacts(
  artifacts: BookingArtifacts,
  eventType: string,
): BookingArtifacts['events'][number] | undefined {
  return artifacts.events.find((event) => event.event_type === eventType);
}

export function findSideEffectArtifacts(
  artifacts: BookingArtifacts,
  eventType: string,
  effectIntent: string,
): BookingArtifacts['events'][number]['side_effects'][number] | undefined {
  return findEventArtifacts(artifacts, eventType)?.side_effects.find((sideEffect) => sideEffect.effect_intent === effectIntent);
}

export async function clickFirstAvailableSlot(page: Page): Promise<{ dateYmd: string; timeLabel: string }> {
  await page.waitForSelector('.cal-day--available:not([disabled])');
  const day = page.locator('.cal-day--available:not([disabled])').first();
  const dateYmd = await day.getAttribute('data-date');
  await day.click();

  await page.waitForSelector('.time-slot');
  const slot = page.locator('.time-slot').first();
  const timeLabel = (await slot.innerText()).trim();
  await slot.click();
  await page.getByRole('button', { name: 'Continue' }).click();

  return {
    dateYmd: dateYmd || '',
    timeLabel,
  };
}

export async function fillContactDetails(
  page: Page,
  details: { firstName: string; lastName: string; email: string; phone?: string | null },
): Promise<void> {
  await page.locator('#f-first-name').fill(details.firstName);
  await page.locator('#f-last-name').fill(details.lastName);
  await page.locator('#f-email').fill(details.email);
  if (details.phone !== undefined) {
    await page.locator('#f-phone').fill(details.phone || '');
  }
  await page.getByRole('button', { name: 'Continue' }).click();
}
