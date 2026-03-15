import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN_BASE_URL,
  SITE_BASE_URL,
  type BookingArtifacts,
  cancelBookingByManageUrl,
  clickFirstAvailableSlot,
  createPayLaterBookingForSlot,
  ensureAntiBotMock,
  ensureEmailMock,
  expireTestBooking,
  expectManageStatus,
  fillContactDetails,
  getSlots,
  makeScenarioEmail,
  waitForSupabasePaymentStatus,
  waitForBookingArtifacts,
} from './support/api';
import { expectInlineMockEmailPreview } from './support/mock-email-preview';
import { attachRuntimeMonitor } from './support/runtime';

type RuntimeMonitor = ReturnType<typeof attachRuntimeMonitor>;
type RuntimeTestInfo = Parameters<RuntimeMonitor['assertNoNewIssues']>[2];

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

function expectPendingPayLaterArtifacts(artifacts: BookingArtifacts) {
  expect(artifacts.booking.status).toBe('PENDING');
  expect(artifacts.payment).toBeNull();
  expect(artifacts.links.confirm_url).toBeTruthy();
}

function expectConfirmedPayLaterArtifacts(artifacts: BookingArtifacts) {
  expect(artifacts.booking.status).toBe('CONFIRMED');
  expect(artifacts.payment).toBeTruthy();
  expect(['PENDING', 'INVOICE_SENT']).toContain(artifacts.payment?.status);
}

async function confirmPendingPayLaterBooking(
  page: Page,
  runtime: RuntimeMonitor,
  pendingArtifacts: BookingArtifacts,
  testInfo: RuntimeTestInfo,
  label: string,
): Promise<BookingArtifacts> {
  const checkpoint = runtime.checkpoint();
  await page.goto(pendingArtifacts.links.confirm_url!);
  await expectInlineMockEmailPreview(page, {
    title: 'Confirmed!',
    frameText: /confirmed|Manage booking|Complete payment/i,
    actionName: /Complete payment/i,
    actionHref: /\/continue-payment\.html\?token=/,
  });
  await runtime.assertNoNewIssues(checkpoint, label, testInfo);

  const confirmedArtifacts = await waitForBookingArtifacts(pendingArtifacts.client.email);
  expectConfirmedPayLaterArtifacts(confirmedArtifacts);
  return confirmedArtifacts;
}

test.describe('P0 pay-later manual arrangement and settlement', () => {
  test.beforeAll(async () => {
    await ensureEmailMock();
    await ensureAntiBotMock();
  });

  test('pay-later booking confirms first, then stays online-continuable after admin marks CASH_OK', async ({ browser, page }, testInfo) => {
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
    await expectInlineMockEmailPreview(page, {
      title: 'Booking received',
      frameText: 'Please confirm your session booking.',
      actionName: 'Confirm booking',
      actionHref: /\/confirm\.html\?token=/,
    });
    await runtime.assertNoNewIssues(checkpoint, 'pay-later-submit-before-manual-arrangement', testInfo);

    const pendingArtifacts = await waitForBookingArtifacts(email);
    expectPendingPayLaterArtifacts(pendingArtifacts);

    const confirmedArtifacts = await confirmPendingPayLaterBooking(
      page,
      runtime,
      pendingArtifacts,
      testInfo,
      'pay-later-confirm-before-manual-arrangement',
    );

    const adminPage = await browser.newPage();
    const adminRuntime = attachRuntimeMonitor(adminPage);
    checkpoint = adminRuntime.checkpoint();
    await openAdminBookingRowByEmail(adminPage, email, confirmedArtifacts.booking.starts_at.slice(0, 10));
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('Payment status');
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('CONFIRMED');
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText(confirmedArtifacts.payment?.status || '');
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('Invoice URL');
    await adminPage.click('#editSetCashOk');
    await expect(adminPage.locator('#editOverlay')).not.toHaveClass(/hidden/);
    await expect(adminPage.locator('#editMsg')).toHaveClass(/ok/);
    await expect(adminPage.locator('#editMsg')).toContainText('Manual arrangement approved.');
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('CASH_OK');
    await expect(adminPage.locator('#editSettlePayment')).toBeEnabled();
    await adminRuntime.assertNoNewIssues(checkpoint, 'admin-approve-manual-arrangement', testInfo);

    const cashOkPayment = await waitForSupabasePaymentStatus(confirmedArtifacts.booking.id, 'CASH_OK');
    expect(cashOkPayment.status).toBe('CASH_OK');
    await adminPage.close();

    const cashOkArtifacts = await waitForBookingArtifacts(email);
    expect(cashOkArtifacts.booking.status).toBe('CONFIRMED');
    expect(cashOkArtifacts.payment?.status).toBe('CASH_OK');

    checkpoint = runtime.checkpoint();
    await page.goto(confirmedArtifacts.links.manage_url);
    await expect(page.locator('.detail-table')).toContainText('CASH OK');
    await runtime.assertNoNewIssues(checkpoint, 'manage-page-after-manual-arrangement', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(continuePaymentUrlFromManageUrl(confirmedArtifacts.links.manage_url));
    await page.waitForURL(/\/dev-pay\?session_id=/);
    await runtime.assertNoNewIssues(checkpoint, 'continue-payment-allows-online-continuation-after-cash-ok', testInfo);

    const refreshedArtifacts = await waitForBookingArtifacts(email);
    expect(refreshedArtifacts.booking.status).toBe('CONFIRMED');
    expect(refreshedArtifacts.payment).toBeTruthy();
    expect(['CASH_OK', 'PENDING']).toContain(refreshedArtifacts.payment?.status);
  });

  test('admin settles an eligible pay-later booking and rejects settling a canceled booking', async ({ browser, page }, testInfo) => {
    const slots = await getSlots('2026-03-14', '2026-06-30', 'session');
    expect(slots.length).toBeGreaterThan(1);

    const [settleSlot, canceledSlot] = slots;
    const settleEmail = makeScenarioEmail('p0-settle-ok');
    const canceledEmail = makeScenarioEmail('p0-settle-canceled');
    const runtime = attachRuntimeMonitor(page);

    await createPayLaterBookingForSlot(settleSlot, settleEmail);
    const settlePendingArtifacts = await waitForBookingArtifacts(settleEmail);
    expectPendingPayLaterArtifacts(settlePendingArtifacts);
    const settleArtifacts = await confirmPendingPayLaterBooking(
      page,
      runtime,
      settlePendingArtifacts,
      testInfo,
      'pay-later-confirm-before-settlement',
    );

    const adminPage = await browser.newPage();
    const adminRuntime = attachRuntimeMonitor(adminPage);
    let checkpoint = adminRuntime.checkpoint();
    await openAdminBookingRowByEmail(adminPage, settleEmail, settleArtifacts.booking.starts_at.slice(0, 10));
    await adminPage.fill('#editSettlementNote', 'E2E manual settlement');
    await adminPage.click('#editSettlePayment');
    await expect(adminPage.locator('#editOverlay')).not.toHaveClass(/hidden/);
    await expect(adminPage.locator('#editMsg')).toHaveClass(/ok/);
    await expect(adminPage.locator('#editMsg')).toContainText('Payment settled.');
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('CONFIRMED');
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('SUCCEEDED');
    await expect(adminPage.locator('#editSettlePayment')).toBeDisabled();
    await adminRuntime.assertNoNewIssues(checkpoint, 'admin-settle-pay-later-booking', testInfo);

    const settledPayment = await waitForSupabasePaymentStatus(settleArtifacts.booking.id, 'SUCCEEDED');
    expect(settledPayment.paid_at).toBeTruthy();

    checkpoint = runtime.checkpoint();
    await page.goto(settleArtifacts.links.manage_url);
    await expect(page.locator('.detail-table')).toContainText('CONFIRMED');
    await expect(page.locator('.detail-table')).toContainText('SUCCEEDED');
    await runtime.assertNoNewIssues(checkpoint, 'manage-page-after-manual-settlement', testInfo);

    await createPayLaterBookingForSlot(canceledSlot, canceledEmail);
    const canceledPendingArtifacts = await waitForBookingArtifacts(canceledEmail);
    expectPendingPayLaterArtifacts(canceledPendingArtifacts);
    const canceledArtifacts = await confirmPendingPayLaterBooking(
      page,
      runtime,
      canceledPendingArtifacts,
      testInfo,
      'pay-later-confirm-before-cancel-and-settlement-denial',
    );
    await cancelBookingByManageUrl(canceledArtifacts.links.manage_url);
    await expectManageStatus(canceledEmail, 'CANCELED');

    checkpoint = adminRuntime.checkpoint();
    await openAdminBookingRowByEmail(adminPage, canceledEmail, canceledArtifacts.booking.starts_at.slice(0, 10));
    await adminPage.click('#editSettlePayment');
    await expect(adminPage.locator('#editOverlay')).not.toHaveClass(/hidden/);
    await expect(adminPage.locator('#editMsg')).toHaveClass(/err/);
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

    checkpoint = adminRuntime.checkpoint();
    await openAdminBookingRowByEmail(adminPage, settleEmail, settleArtifacts.booking.starts_at.slice(0, 10));
    await adminPage.click('#editSettlePayment');
    await expect(adminPage.locator('#editOverlay')).not.toHaveClass(/hidden/);
    await expect(adminPage.locator('#editMsg')).toHaveClass(/err/);
    await expect(adminPage.locator('#editMsg')).toContainText(/Payment cannot be settled from its current state/i);
    await adminRuntime.assertNoNewIssues(checkpoint, 'admin-deny-settle-already-settled-booking', testInfo, {
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

  test('confirmed unpaid pay-later booking becomes EXPIRED and blocks continuation after the expiry path runs', async ({ browser, page }, testInfo) => {
    const email = makeScenarioEmail('p0-expired');
    const runtime = attachRuntimeMonitor(page);
    const slots = await getSlots('2026-03-14', '2026-06-30', 'session');
    expect(slots.length).toBeGreaterThan(0);
    await createPayLaterBookingForSlot(slots[0]!, email);
    const pendingArtifacts = await waitForBookingArtifacts(email);
    expectPendingPayLaterArtifacts(pendingArtifacts);
    const artifacts = await confirmPendingPayLaterBooking(
      page,
      runtime,
      pendingArtifacts,
      testInfo,
      'pay-later-confirm-before-expiry',
    );
    const expireResult = await expireTestBooking(email);
    expect(expireResult.status).toBe('EXPIRED');

    let checkpoint = runtime.checkpoint();
    await page.goto(artifacts.links.manage_url);
    await expect(page.locator('.detail-table')).toContainText('EXPIRED');
    await expect(page.locator('.manage-actions')).not.toContainText('Reschedule');
    await runtime.assertNoNewIssues(checkpoint, 'manage-page-after-expiry', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(continuePaymentUrlFromManageUrl(artifacts.links.manage_url));
    await expect(page.locator('.manage-title')).toContainText('Your Booking');
    await expect(page.locator('.detail-table')).toContainText('EXPIRED');
    expect(page.url()).not.toContain('/dev-pay');
    expect(page.url()).not.toContain('/mock-invoice');
    await runtime.assertNoNewIssues(checkpoint, 'continue-payment-blocked-after-expiry', testInfo);

    const refreshedArtifacts = await waitForBookingArtifacts(email);
    expect(refreshedArtifacts.booking.status).toBe('EXPIRED');
    expect(refreshedArtifacts.payment).toBeTruthy();
    expect(['PENDING', 'INVOICE_SENT']).toContain(refreshedArtifacts.payment?.status);

    const adminPage = await browser.newPage();
    const adminRuntime = attachRuntimeMonitor(adminPage);
    checkpoint = adminRuntime.checkpoint();
    await openAdminBookingRowByEmail(adminPage, email, artifacts.booking.starts_at.slice(0, 10));
    await expect(adminPage.locator('#editReadonlyDetails')).toContainText('EXPIRED');
    await adminRuntime.assertNoNewIssues(checkpoint, 'admin-view-expired-booking', testInfo);
    await adminPage.close();
  });
});
