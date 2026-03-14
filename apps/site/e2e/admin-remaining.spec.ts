import { expect, test } from '@playwright/test';
import {
  ADMIN_BASE_URL,
  API_BASE_URL,
  SITE_BASE_URL,
  clickFirstAvailableSlot,
  ensureEmailMock,
  expectManageStatus,
  fillContactDetails,
  getAdminContactMessages,
  getAdminEventsAll,
  makeScenarioEmail,
  waitForBookingArtifacts,
} from './support/api';
import { attachRuntimeMonitor } from './support/runtime';

async function createConfirmedIntroBooking(page: import('@playwright/test').Page, email: string) {
  await page.goto(`${SITE_BASE_URL}/sessions.html`);
  await page.locator('a.btn[href*="book.html?type=intro"]').first().click();
  await clickFirstAvailableSlot(page);
  await fillContactDetails(page, {
    firstName: 'P4',
    lastName: 'Admin',
    email,
    phone: '',
  });
  await page.locator('button[data-submit]').click();
  const pending = await waitForBookingArtifacts(email);
  await page.goto(pending.links.confirm_url!);
  await expect(page.locator('.confirm-title')).toContainText('Confirmed');
  return expectManageStatus(email, 'CONFIRMED');
}

async function openBookingRowByEmail(page: import('@playwright/test').Page, email: string, dateYmd: string) {
  await page.goto(`${ADMIN_BASE_URL}/index.html`);
  await page.selectOption('#source', 'session');
  await page.fill('#date', dateYmd);
  await page.click('#loadRows');
  await page.fill('#searchInput', email);
  const row = page.locator('#rowsBody tr', { hasText: email }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('#editOverlay')).not.toHaveClass(/hidden/);
}

test.describe('P4 remaining admin and content coverage', () => {
  test.beforeAll(async () => {
    await ensureEmailMock();
  });

  test('T27 organizer pages require sign-in', async () => {
    test.fixme(true, 'Current pre-prod environment is intentionally unprotected, so this scenario is not meaningful until auth is restored.');
  });

  test('T28 view and filter bookings in admin', async ({ page }, testInfo) => {
    const email = makeScenarioEmail('p4-admin-filter');
    const booking = await createConfirmedIntroBooking(page, email);
    const runtime = attachRuntimeMonitor(page);

    const checkpoint = runtime.checkpoint();
    await page.goto(`${ADMIN_BASE_URL}/index.html`);
    await page.selectOption('#source', 'session');
    await page.fill('#date', booking.booking.starts_at.slice(0, 10));
    await page.click('#loadRows');
    await page.fill('#searchInput', email);
    await expect(page.locator('#rowsBody tr', { hasText: email })).toHaveCount(1);
    await runtime.assertNoNewIssues(checkpoint, 'admin-view-filter-bookings', testInfo);
  });

  test('T30 generate client-safe manage link', async ({ browser, page }, testInfo) => {
    const email = makeScenarioEmail('p4-admin-client-link');
    const booking = await createConfirmedIntroBooking(page, email);
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const adminPage = await context.newPage();
    const runtime = attachRuntimeMonitor(adminPage);

    const checkpoint = runtime.checkpoint();
    await openBookingRowByEmail(adminPage, email, booking.booking.starts_at.slice(0, 10));
    await adminPage.click('#editCopyClientManage');
    await expect(adminPage.locator('#editMsg')).toContainText('Client manage link copied to clipboard.');
    const clipboardText = await adminPage.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain('/manage.html?token=');
    expect(clipboardText).not.toContain('admin_token=');
    await runtime.assertNoNewIssues(checkpoint, 'admin-copy-client-manage-link', testInfo);
    await adminPage.close();
    await context.close();
  });

  test('T31 generate privileged admin link', async ({ browser, page }, testInfo) => {
    const email = makeScenarioEmail('p4-admin-priv-link');
    const booking = await createConfirmedIntroBooking(page, email);
    const adminPage = await browser.newPage();
    const runtime = attachRuntimeMonitor(adminPage);

    const checkpoint = runtime.checkpoint();
    await openBookingRowByEmail(adminPage, email, booking.booking.starts_at.slice(0, 10));
    const popupPromise = adminPage.waitForEvent('popup');
    await adminPage.click('#editOpenManage');
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toMatch(/\/manage(?:\.html)?\?token=/);
    expect(popup.url()).toContain('admin_token=');
    await runtime.assertNoNewIssues(checkpoint, 'admin-open-privileged-manage-link', testInfo);
    await popup.close();
    await adminPage.close();
  });

  test('T32 rotate late-access link revokes the old link and returns a working new one', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const event = (await getAdminEventsAll()).find((row) => row.status === 'published' && row.is_paid === false);
    test.skip(!event, 'No published free event available for late-access rotation.');

    const checkpoint = runtime.checkpoint();
    await page.goto(`${ADMIN_BASE_URL}/index.html`);
    await page.selectOption('#source', 'event');
    await page.selectOption('#eventId', event.id);
    await page.click('#rotateLateAccess');
    const firstLink = page.locator('#lateAccessInfo a');
    await expect(firstLink).toBeVisible();
    const firstUrl = await firstLink.getAttribute('href');

    await page.click('#rotateLateAccess');
    await expect(firstLink).toBeVisible();
    const secondUrl = await firstLink.getAttribute('href');
    expect(secondUrl).toBeTruthy();
    expect(secondUrl).not.toBe(firstUrl);

    const oldAccess = new URL(firstUrl!).searchParams.get('access');
    const newAccess = new URL(secondUrl!).searchParams.get('access');
    const email = makeScenarioEmail('p4-late-access');

    const oldResponse = await fetch(`${API_BASE_URL}/api/events/${event.slug}/book-with-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        access_token: oldAccess,
        first_name: 'P4',
        last_name: 'Late',
        email,
        phone: '+41790000000',
        turnstile_token: 'test_turnstile_ok',
      }),
    });
    expect(oldResponse.status).toBe(400);

    const newResponse = await fetch(`${API_BASE_URL}/api/events/${event.slug}/book-with-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        access_token: newAccess,
        first_name: 'P4',
        last_name: 'Late',
        email,
        phone: '+41790000000',
        turnstile_token: 'test_turnstile_ok',
      }),
    });
    expect(newResponse.ok).toBe(true);
    await runtime.assertNoNewIssues(checkpoint, 'admin-rotate-late-access-link', testInfo);
  });

  test('T33 view contact messages', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p4-contact-admin');

    await page.goto(`${SITE_BASE_URL}/contact.html`);
    await page.fill('[name="first_name"]', 'P4');
    await page.fill('[name="email"]', email);
    await page.fill('[name="message"]', 'P4 admin message body');
    await page.click('#contact-submit-btn');
    await expect(page.locator('#contact-success')).toBeVisible();

    const rows = await getAdminContactMessages();
    const row = rows.find((entry) => entry.client_email === email);
    expect(row).toBeTruthy();

    const checkpoint = runtime.checkpoint();
    await page.goto(`${ADMIN_BASE_URL}/contact-messages.html`);
    await page.fill('#q', email);
    await page.click('#loadRows');
    const targetRow = page.locator('#rowsBody tr', { hasText: email }).first();
    await expect(targetRow).toBeVisible();
    await targetRow.locator('.message-preview').click();
    await expect(page.locator('#messageFull')).toContainText('P4 admin message body');
    await runtime.assertNoNewIssues(checkpoint, 'admin-view-contact-messages', testInfo);
  });

  test('T34 create session type', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const slug = `p4-session-${Date.now()}`;

    const checkpoint = runtime.checkpoint();
    await page.goto(`${ADMIN_BASE_URL}/session-types.html`);
    await page.click('#newBtn');
    await page.fill('#stFTitle', 'P4 Session Type');
    await page.fill('#stFSlug', slug);
    await page.fill('#stFShort', 'P4 short');
    await page.fill('#stFDesc', 'P4 description');
    await page.fill('#stFDuration', '75');
    await page.fill('#stFPrice', '111');
    await page.selectOption('#stFStatus', 'active');
    await page.click('#stSave');
    await expect(page.locator('#stBody tr', { hasText: 'P4 Session Type' })).toBeVisible();
    await runtime.assertNoNewIssues(checkpoint, 'admin-create-session-type', testInfo);
  });

  test('T35 edit session type including image-backed content', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const updatedTitle = `P4 Session Type Updated ${Date.now()}`;

    const checkpoint = runtime.checkpoint();
    await page.goto(`${ADMIN_BASE_URL}/session-types.html`);
    const row = page.locator('#stBody tr', { hasText: 'P4 Session Type' }).first();
    await expect(row).toBeVisible();
    await row.click();
    await page.fill('#stFTitle', updatedTitle);
    await page.fill('#stFDesc', 'Updated P4 description with image');
    await page.locator('#stFImage').setInputFiles({
      name: 'p4.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    await expect(page.locator('#stImgMsg')).toContainText('Uploaded.');
    await page.click('#stSave');
    await expect(page.locator('#stBody tr', { hasText: updatedTitle })).toBeVisible();
    await runtime.assertNoNewIssues(checkpoint, 'admin-edit-session-type-image', testInfo);
  });

  test('T36 edit existing event including capacity timing and content', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const event = (await getAdminEventsAll()).find((row) => row.slug === 'ev-p4-paid-mock-20260314') || (await getAdminEventsAll())[0];
    test.skip(!event, 'No editable event exists in the target environment.');
    const originalTitle = event.title;
    const updatedTitle = `${originalTitle} [P4]`;

    const checkpoint = runtime.checkpoint();
    await page.goto(`${ADMIN_BASE_URL}/session-types.html`);
    await page.click('[data-tab="events"]');
    const row = page.locator('#evBody tr', { hasText: originalTitle }).first();
    await expect(row).toBeVisible();
    await row.click();
    await page.fill('#evFTitle', updatedTitle);
    await page.fill('#evFCapacity', String(Number(event.capacity || 0) + 1));
    await page.fill('#evFDesc', `${event.description} Updated by P4.`);
    await page.click('#evSave');
    await expect(page.locator('#evBody tr', { hasText: updatedTitle })).toBeVisible();
    await runtime.assertNoNewIssues(checkpoint, 'admin-edit-event', testInfo);
  });
});
