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
