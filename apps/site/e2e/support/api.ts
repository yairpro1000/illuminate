import { expect, type Page } from '@playwright/test';

export const SITE_BASE_URL = process.env.E2E_SITE_BASE_URL || 'https://letsilluminate.co';
export const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || 'https://admin.letsilluminate.co';
export const API_BASE_URL = process.env.E2E_API_BASE_URL || 'https://api.letsilluminate.co';

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
  };
}

export interface PublicSlot {
  type: 'intro' | 'session';
  start: string;
  end: string;
}

export function makeScenarioEmail(prefix: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

export async function getSlots(from: string, to: string, type: 'intro' | 'session', tz = 'Europe/Zurich'): Promise<PublicSlot[]> {
  const params = new URLSearchParams({ from, to, type, tz });
  const data = await apiJson<{ slots: PublicSlot[] }>(`/api/slots?${params.toString()}`);
  return Array.isArray(data.slots) ? data.slots : [];
}

export async function createPayNowBookingForSlot(slot: PublicSlot, email: string): Promise<{ booking_id: string; checkout_url: string | null; checkout_hold_expires_at: string | null }> {
  return apiJson('/api/bookings/pay-now', {
    method: 'POST',
    body: JSON.stringify({
      slot_start: slot.start,
      slot_end: slot.end,
      type: slot.type,
      timezone: 'Europe/Zurich',
      first_name: 'P4',
      last_name: 'E2E',
      client_email: email,
      client_phone: '+41790000000',
      turnstile_token: 'test_turnstile_ok',
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

export async function expectManageStatus(email: string, expectedStatus: string): Promise<BookingArtifacts> {
  const artifacts = await waitForBookingArtifacts(email);
  expect(artifacts.booking.status).toBe(expectedStatus);
  return artifacts;
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
