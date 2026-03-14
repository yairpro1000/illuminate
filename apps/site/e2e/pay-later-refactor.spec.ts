import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN_BASE_URL,
  SITE_BASE_URL,
  cancelBookingByManageUrl,
  clickFirstAvailableSlot,
  createPayLaterBookingForSlot,
  ensureEmailMock,
  expectManageStatus,
  fillContactDetails,
  getSlots,
  makeScenarioEmail,
  waitForBookingArtifacts,
} from './support/api';
import { attachRuntimeMonitor } from './support/runtime';

async function openAdminBookingRowByEmail(page: Page, email: string, dateYmd: string) {
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

function continuePaymentUrlFromManageUrl(manageUrl: string): string {
  const url = new URL(manageUrl);
  url.pathname = url.pathname.replace(/manage(?:\.html)?$/, 'continue-payment.html');
  return url.toString();
}

test.describe('P0 pay-later manual arrangement and settlement', () => {
  test.beforeAll(async () => {
    await ensureEmailMock();
  });

  test('pay-later booking stays out of checkout after admin approves manual arrangement', async ({ browser, page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p0-cash-ok');

    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await page.locator('a.btn[href*="book.html?type=session&offer="]').first().click();
    await expect(page).toHaveURL(/\/book(?:\.html)?\?type=session/);

    let checkpoint = runtime.checkpoint();
    await clickFirstAvailableSlot(page);
    await fillContactDetails(page, {
      firstName: 'P0',
      lastName: 'CashOk',
      email,
      phone: '+41790000000',
    });
    await page.locator('[data-payment="pay-later"]').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('button[data-submit]').click();
    await expect(page.locator('.confirmation__title')).toContainText('Booking received');
    await expect(page.getByRole('link', { name: 'Complete payment' })).toHaveAttribute('href', /\/continue-payment\.html\?token=/);
    await runtime.assertNoNewIssues(checkpoint, 'pay-later-submit-before-manual-arrangement', testInfo);

    const artifacts = await waitForBookingArtifacts(email);
    expect(artifacts.booking.status).toBe('PENDING');
    expect(artifacts.payment?.status).toBe('PENDING');

    const adminPage = await browser.newPage();
    const adminRuntime = attachRuntimeMonitor(adminPage);
    checkpoint = adminRuntime.checkpoint();
    await openAdminBookingRowByEmail(adminPage, email, artifacts.booking.starts_at.slice(0, 10));
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('Payment status');
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('PENDING');
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('Invoice URL');
    await adminPage.click('#editSetCashOk');
    await openAdminBookingRowByEmail(adminPage, email, artifacts.booking.starts_at.slice(0, 10));
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('CASH_OK');
    await expect(adminPage.locator('#editSettlePayment')).toBeEnabled();
    await adminRuntime.assertNoNewIssues(checkpoint, 'admin-approve-manual-arrangement', testInfo);
    await adminPage.close();

    checkpoint = runtime.checkpoint();
    await page.goto(artifacts.links.manage_url);
    await expect(page.locator('.detail-table')).toContainText('CASH OK');
    await expect(page.getByRole('link', { name: 'Complete payment' })).toHaveCount(0);
    await runtime.assertNoNewIssues(checkpoint, 'manage-page-after-manual-arrangement', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(continuePaymentUrlFromManageUrl(artifacts.links.manage_url));
    await page.waitForURL(/\/manage(?:\.html)?\?token=/);
    expect(page.url()).not.toContain('/dev-pay');
    expect(page.url()).not.toContain('/mock-invoice');
    await expect(page.locator('.detail-table')).toContainText('CASH OK');
    await runtime.assertNoNewIssues(checkpoint, 'continue-payment-redirects-to-manage-after-cash-ok', testInfo);

    const refreshedArtifacts = await waitForBookingArtifacts(email);
    expect(refreshedArtifacts.payment?.status).toBe('CASH_OK');
  });

  test('admin settles an eligible pay-later booking and rejects settling a canceled booking', async ({ browser, page }, testInfo) => {
    const slots = await getSlots('2026-03-14', '2026-06-30', 'session');
    expect(slots.length).toBeGreaterThan(1);

    const [settleSlot, canceledSlot] = slots;
    const settleEmail = makeScenarioEmail('p0-settle-ok');
    const canceledEmail = makeScenarioEmail('p0-settle-canceled');

    await createPayLaterBookingForSlot(settleSlot, settleEmail);
    const settleArtifacts = await waitForBookingArtifacts(settleEmail);
    expect(settleArtifacts.booking.status).toBe('PENDING');

    const adminPage = await browser.newPage();
    const adminRuntime = attachRuntimeMonitor(adminPage);
    let checkpoint = adminRuntime.checkpoint();
    await openAdminBookingRowByEmail(adminPage, settleEmail, settleArtifacts.booking.starts_at.slice(0, 10));
    await adminPage.fill('#editSettlementNote', 'E2E manual settlement');
    await adminPage.click('#editSettlePayment');
    await openAdminBookingRowByEmail(adminPage, settleEmail, settleArtifacts.booking.starts_at.slice(0, 10));
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('CONFIRMED');
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('SUCCEEDED');
    await expect(adminPage.locator('#editSettlePayment')).toBeDisabled();
    await adminRuntime.assertNoNewIssues(checkpoint, 'admin-settle-pay-later-booking', testInfo);

    const runtime = attachRuntimeMonitor(page);
    checkpoint = runtime.checkpoint();
    await page.goto(settleArtifacts.links.manage_url);
    await expect(page.locator('.detail-table')).toContainText('CONFIRMED');
    await expect(page.locator('.detail-table')).toContainText('SUCCEEDED');
    await runtime.assertNoNewIssues(checkpoint, 'manage-page-after-manual-settlement', testInfo);

    await createPayLaterBookingForSlot(canceledSlot, canceledEmail);
    const canceledArtifacts = await waitForBookingArtifacts(canceledEmail);
    await cancelBookingByManageUrl(canceledArtifacts.links.manage_url);
    await expectManageStatus(canceledEmail, 'CANCELED');

    checkpoint = adminRuntime.checkpoint();
    await openAdminBookingRowByEmail(adminPage, canceledEmail, canceledArtifacts.booking.starts_at.slice(0, 10));
    await adminPage.click('#editSettlePayment');
    await expect(adminPage.locator('#editMsg')).toContainText(/Only pending bookings can be settled manually|Payment cannot be settled from its current state/i);
    await adminRuntime.assertNoNewIssues(checkpoint, 'admin-deny-settle-canceled-booking', testInfo, {
      allow: [
        {
          kind: 'http',
          urlIncludes: '/payment-settled',
          messageIncludes: '-> 409',
        },
        {
          kind: 'console',
          urlIncludes: '/js/client.js',
          messageIncludes: 'request_failure',
        },
      ],
    });

    await adminPage.close();
  });

  test.fixme('invoice continuation gracefully handles a missing invoice URL', async () => {
  });

  test.fixme('pending unpaid booking becomes EXPIRED and blocks continuation after the expiry path runs', async () => {
  });
});
