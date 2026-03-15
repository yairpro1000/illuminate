import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SITE_BASE_URL,
  clickFirstAvailableSlot,
  fillContactDetails,
  makeScenarioEmail,
} from './support/api';
import { attachRuntimeMonitor } from './support/runtime';

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

async function routeWorkspaceSite(page: Page): Promise<void> {
  await page.route('https://letsilluminate.co/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }

    const normalizedPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const relativePath = normalizedPath.replace(/^\/+/, '');
    const filePath = path.resolve(SITE_ROOT, relativePath);
    if (!filePath.startsWith(SITE_ROOT)) {
      await route.abort();
      return;
    }

    try {
      const body = await readFile(filePath);
      await route.fulfill({
        status: 200,
        body,
        contentType: contentTypeFor(filePath),
      });
    } catch {
      await route.continue();
    }
  });
}

test.describe('mock email inline preview', () => {
  test('pay-later booking, contact submit, and confirm follow-up render captured emails inline', async ({ page }, testInfo) => {
    await routeWorkspaceSite(page);
    const runtime = attachRuntimeMonitor(page);

    const bookingEmail = makeScenarioEmail('inline-preview-booking');
    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await page.locator('a.btn[href*="book.html?type=session&offer="]').first().click();
    await expect(page).toHaveURL(/\/book(?:\.html)?\?type=session/);

    let checkpoint = runtime.checkpoint();
    await clickFirstAvailableSlot(page);
    await fillContactDetails(page, {
      firstName: 'Inline',
      lastName: 'Preview',
      email: bookingEmail,
      phone: '+41790000000',
    });
    await page.locator('[data-payment="pay-later"]').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('button[data-submit]').click();
    await expect(page.locator('iframe.mock-email-preview__frame')).toBeVisible();
    const bookingEmailFrame = page.frameLocator('iframe.mock-email-preview__frame');
    const confirmLink = bookingEmailFrame.getByRole('link', { name: /Confirm booking/i });
    await expect(confirmLink).toBeVisible();
    const confirmHref = await confirmLink.getAttribute('href');
    expect(confirmHref).toMatch(/confirm\.html\?token=/);
    await page.screenshot({ path: testInfo.outputPath('booking-inline-preview.png'), fullPage: true });
    await runtime.assertNoNewIssues(checkpoint, 'pay-later-inline-preview', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(String(confirmHref));
    await expect(page.locator('iframe.mock-email-preview__frame')).toBeVisible();
    const confirmationFrame = page.frameLocator('iframe.mock-email-preview__frame');
    await expect(confirmationFrame.locator('body')).toContainText(/confirmed|Manage booking|Complete payment/i);
    await page.screenshot({ path: testInfo.outputPath('confirm-inline-preview.png'), fullPage: true });
    await runtime.assertNoNewIssues(checkpoint, 'confirm-inline-preview', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/contact.html`);
    await page.locator('#contact-first-name').fill('Inline');
    await page.locator('#contact-last-name').fill('Preview');
    await page.locator('#contact-email').fill(makeScenarioEmail('inline-preview-contact'));
    await page.locator('#contact-message').fill('Hello from the inline mock-email Playwright proof.');
    await page.locator('#contact-submit-btn').click();
    await expect(page.locator('iframe.mock-email-preview__frame')).toBeVisible();
    const contactFrame = page.frameLocator('iframe.mock-email-preview__frame');
    await expect(contactFrame.locator('body')).toContainText('Hello from the inline mock-email Playwright proof.');
    await page.screenshot({ path: testInfo.outputPath('contact-inline-preview.png'), fullPage: true });
    await runtime.assertNoNewIssues(checkpoint, 'contact-inline-preview', testInfo);
  });
});
