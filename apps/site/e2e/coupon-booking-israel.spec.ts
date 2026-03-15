import { expect, test, type Page } from '@playwright/test';
import {
  ensureAntiBotMock,
  ensureEmailMock,
  fillContactDetails,
  SITE_BASE_URL,
  waitForBookingArtifacts,
  waitForSupabaseBookingSnapshot,
  waitForSupabasePaymentStatus,
} from './support/api';
import { openAdminBookingRowByEmail, expectAdminBookingCommercials } from './support/admin-booking';
import {
  applyIsraelCouponFromSessionsBanner,
  applyIsraelCouponOnReview,
  prepareIsraelCouponVisitor,
  removeIsraelCouponFromIndicator,
} from './support/coupon-booking';
import { attachRuntimeMonitor } from './support/runtime';

function parseFirstChfAmount(text: string | null): number {
  const match = String(text || '').match(/CHF\s+(\d+(?:\.\d+)?)/i);
  if (!match) throw new Error(`Could not parse CHF amount from: ${text}`);
  return Number(match[1]);
}

function makeArtifactSafeEmail(prefix: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}@example.test`;
}

async function extractReviewCouponAmounts(page: Page): Promise<{ baseChf: number; finalChf: number }> {
  const oldText = await page.locator('.review-table .coupon-price__old').first().innerText();
  const newText = await page.locator('.review-table .coupon-price__new').first().innerText();
  return {
    baseChf: parseFirstChfAmount(oldText),
    finalChf: parseFirstChfAmount(newText),
  };
}

async function completePayNowFromReview(page: Page): Promise<void> {
  await page.locator('button[data-submit]').click();
  await page.waitForURL(/\/dev-pay\?session_id=/);
  await page.locator('#btn-success').click();
  await page.waitForURL(/\/payment-success(\.html)?\?session_id=/);
  await expect(page.locator('.result-title')).toContainText(/Payment confirmed!|Payment received/);
}

async function verifyDiscountedPayNowArtifacts(
  browserPageFactory: () => Promise<Page>,
  email: string,
  expectedFinalChf: number,
): Promise<void> {
  const artifacts = await waitForBookingArtifacts(email);
  const bookingRow = await waitForSupabaseBookingSnapshot(
    artifacts.booking.id,
    (row) => row.coupon_code === 'ISRAEL' && Number(row.price) === expectedFinalChf,
  );
  expect(bookingRow.coupon_code).toBe('ISRAEL');
  expect(Number(bookingRow.price)).toBe(expectedFinalChf);

  const paymentRow = await waitForSupabasePaymentStatus(artifacts.booking.id, ['SUCCEEDED', 'PENDING']);
  expect(Number(paymentRow.amount)).toBe(expectedFinalChf);

  const adminPage = await browserPageFactory();
  try {
    await openAdminBookingRowByEmail(adminPage, email, artifacts.booking.starts_at.slice(0, 10), 'session');
    await expectAdminBookingCommercials(adminPage, {
      bookedPriceChf: expectedFinalChf,
      couponCode: 'ISRAEL',
      paymentAmountChf: expectedFinalChf,
    });
  } finally {
    await adminPage.close();
  }
}

test.describe('Israel coupon discounted booking flows', () => {
  test.beforeAll(async () => {
    await ensureEmailMock();
    await ensureAntiBotMock();
  });

  async function runBannerAppliedPayNowCase(
    page: Page,
    browserPageFactory: () => Promise<Page>,
    email: string,
    testInfo: Parameters<ReturnType<typeof attachRuntimeMonitor>['assertNoNewIssues']>[2],
  ) {
    const runtime = attachRuntimeMonitor(page);
    await prepareIsraelCouponVisitor(page);

    let checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await applyIsraelCouponFromSessionsBanner(page);
    await page.locator('a.btn[href*="book.html?type=session&offer="]').first().click();
    await expect(page).toHaveURL(/\/book(?:\.html)?\?type=session/);
    await page.waitForSelector('.cal-day--available:not([disabled])');
    const day = page.locator('.cal-day--available:not([disabled])').first();
    await day.click();
    const slot = page.locator('.time-slot').first();
    await slot.click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillContactDetails(page, {
      firstName: 'P4',
      lastName: 'Coupon',
      email,
      phone: '+41790000000',
    });
    await page.locator('[data-payment="pay-now"]').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    const amounts = await extractReviewCouponAmounts(page);
    await completePayNowFromReview(page);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-banner-pay-now-session', testInfo);

    await verifyDiscountedPayNowArtifacts(browserPageFactory, email, amounts.finalChf);
  }

  async function runReviewAppliedPayNowCase(
    page: Page,
    browserPageFactory: () => Promise<Page>,
    email: string,
    testInfo: Parameters<ReturnType<typeof attachRuntimeMonitor>['assertNoNewIssues']>[2],
  ) {
    const runtime = attachRuntimeMonitor(page);
    await prepareIsraelCouponVisitor(page);

    let checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await applyIsraelCouponFromSessionsBanner(page);
    await removeIsraelCouponFromIndicator(page);
    await page.locator('a.btn[href*="book.html?type=session&offer="]').first().click();
    await expect(page).toHaveURL(/\/book(?:\.html)?\?type=session/);
    await page.waitForSelector('.cal-day--available:not([disabled])');
    const day = page.locator('.cal-day--available:not([disabled])').first();
    await day.click();
    const slot = page.locator('.time-slot').first();
    await slot.click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await fillContactDetails(page, {
      firstName: 'P4',
      lastName: 'CouponManual',
      email,
      phone: '+41790000000',
    });
    await page.locator('[data-payment="pay-now"]').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await applyIsraelCouponOnReview(page);
    const amounts = await extractReviewCouponAmounts(page);
    await completePayNowFromReview(page);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-review-pay-now-session', testInfo);

    await verifyDiscountedPayNowArtifacts(browserPageFactory, email, amounts.finalChf);
  }

  test('pay-now session booking keeps Israel discount when applied from sessions banner', async ({ browser, page }, testInfo) => {
    await runBannerAppliedPayNowCase(page, () => browser.newPage(), makeArtifactSafeEmail('p4-coupon-banner-pay-now'), testInfo);
  });

  test('@mobile pay-now session booking keeps Israel discount when applied from sessions banner', async ({ browser, page }, testInfo) => {
    await runBannerAppliedPayNowCase(page, () => browser.newPage(), makeArtifactSafeEmail('p4-coupon-banner-pay-now-mobile'), testInfo);
  });

  test('pay-now session booking can remove Israel discount then reapply it manually on review', async ({ browser, page }, testInfo) => {
    await runReviewAppliedPayNowCase(page, () => browser.newPage(), makeArtifactSafeEmail('p4-coupon-review-pay-now'), testInfo);
  });

  test('@mobile pay-now session booking can remove Israel discount then reapply it manually on review', async ({ browser, page }, testInfo) => {
    await runReviewAppliedPayNowCase(page, () => browser.newPage(), makeArtifactSafeEmail('p4-coupon-review-pay-now-mobile'), testInfo);
  });
});
