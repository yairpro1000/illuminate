import { expect, type Page } from '@playwright/test';
import { ADMIN_BASE_URL } from './api';

function formatMoneyValue(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d*[1-9])0$/, '$1');
}

export function formatChf(value: number): string {
  return `${formatMoneyValue(value)} CHF`;
}

export async function openAdminBookingRowByEmail(page: Page, email: string, dateYmd: string, source: 'session' | 'event' = 'session') {
  await page.goto(`${ADMIN_BASE_URL}/index.html`);
  await page.selectOption('#source', source);
  await page.fill('#date', dateYmd);
  await page.click('#loadRows');
  await page.fill('#searchInput', email);
  const row = page.locator('#rowsBody tr', { hasText: email }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('#editOverlay')).not.toHaveClass(/hidden/);
}

export async function expectAdminBookingCommercials(
  page: Page,
  input: {
    bookedPriceChf: number;
    couponCode: string;
    paymentAmountChf?: number | null;
  },
): Promise<void> {
  const details = page.locator('#editReadonlyDetails');
  await expect(details).toContainText('Booked price');
  await expect(details).toContainText(formatChf(input.bookedPriceChf));
  await expect(details).toContainText('Coupon code');
  await expect(details).toContainText(input.couponCode);

  if (input.paymentAmountChf != null) {
    await expect(details).toContainText('Amount');
    await expect(details).toContainText(formatChf(input.paymentAmountChf));
  }
}
