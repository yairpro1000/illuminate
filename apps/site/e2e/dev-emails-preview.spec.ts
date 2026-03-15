import { expect, test } from '@playwright/test';
import {
  API_BASE_URL,
  SITE_BASE_URL,
  ensureAntiBotMock,
  createPayLaterBookingForSlot,
  ensureEmailMock,
  getSlots,
  makeScenarioEmail,
  waitForBookingArtifacts,
  waitForCapturedEmail,
} from './support/api';
import { attachRuntimeMonitor } from './support/runtime';

test.describe('dev email preview', () => {
  test.beforeAll(async () => {
    await ensureEmailMock();
    await ensureAntiBotMock();
  });

  test('renders the captured booking confirmation request HTML exactly enough to inspect the real CTA link', async ({ page }, testInfo) => {
    const slots = await getSlots('2026-03-15', '2026-07-15', 'intro');
    test.skip(slots.length === 0, 'No intro slots available in the target environment.');

    const email = makeScenarioEmail('p4-email-preview');
    await createPayLaterBookingForSlot(slots[0]!, email);

    const artifacts = await waitForBookingArtifacts(email);
    const captured = await waitForCapturedEmail(email, 'booking_confirm_request');
    const runtime = attachRuntimeMonitor(page);

    const checkpoint = runtime.checkpoint();
    await page.addInitScript((apiBase) => {
      window.localStorage.setItem('API_BASE', apiBase);
    }, API_BASE_URL);
    await page.goto(`${SITE_BASE_URL}/dev-emails.html?email_id=${encodeURIComponent(captured.id)}`);
    await expect(page.locator(`[data-email-id="${captured.id}"]`)).toHaveClass(/is-active/);
    await expect(page.locator('.email-preview-frame')).toBeVisible();

    const frame = page.frameLocator('.email-preview-frame');
    await expect(frame.locator('img[alt="ILLUMINATE by Yair Benharroch"]')).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Confirm booking' })).toHaveAttribute('href', artifacts.links.confirm_url!);
    await expect(frame.locator('.detail-block')).toContainText('Session');

    await runtime.assertNoNewIssues(checkpoint, 'dev-email-preview-page', testInfo);
  });
});
