import { expect, test } from '@playwright/test';
import { SITE_BASE_URL, ensureEmailMock } from './support/api';
import {
  clearAppliedCouponState,
  couponBanner,
  expectCouponIndicatorVisible,
  expectCouponBannerVisible,
  expectDiscountedPrices,
  expectNoCouponBanner,
  expectStandardPrices,
  expectStickyCouponBanner,
  expectViewportRelativeCouponIndicator,
  forceVisitorCountry,
  acceptCouponBanner,
  removeCouponFromIndicator,
} from './support/coupon';
import { attachRuntimeMonitor } from './support/runtime';

async function prepareIsraelVisitor(page: import('@playwright/test').Page): Promise<void> {
  await clearAppliedCouponState(page);
  await forceVisitorCountry(page, 'IL');
}

async function scrollSessionsBannerIntoView(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#session-types').scrollIntoViewIfNeeded();
}

test.describe('Israel coupon banner', () => {
  test.beforeAll(async () => {
    await ensureEmailMock();
  });

  test('desktop Israel visitor sees the coupon banner only on expected public surfaces and home banner stays sticky on scroll', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    await prepareIsraelVisitor(page);

    await page.goto(`${SITE_BASE_URL}/`);
    await expectNoCouponBanner(page);

    let checkpoint = runtime.checkpoint();
    await page.locator('#how-we-work').scrollIntoViewIfNeeded();
    await expectCouponBannerVisible(page);
    await expect(couponBanner(page)).toContainText('Apply Israel discount');
    await expectStickyCouponBanner(page);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-home-banner', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await scrollSessionsBannerIntoView(page);
    await expectCouponBannerVisible(page);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-sessions-banner', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/evenings.html`);
    await expectNoCouponBanner(page);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-evenings-no-banner', testInfo);
  });

  test('@mobile Israel visitor sees the coupon banner on the expected mobile surfaces', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    await prepareIsraelVisitor(page);

    await page.goto(`${SITE_BASE_URL}/`);
    await expectNoCouponBanner(page);

    let checkpoint = runtime.checkpoint();
    await page.locator('#how-we-work').scrollIntoViewIfNeeded();
    await expectCouponBannerVisible(page);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-home-banner-mobile', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await scrollSessionsBannerIntoView(page);
    await expectCouponBannerVisible(page);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-sessions-banner-mobile', testInfo);
  });

  test('desktop Israel visitor can accept the banner, see discounted pricing, then remove it and restore standard prices', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    await prepareIsraelVisitor(page);

    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await scrollSessionsBannerIntoView(page);
    await expectCouponBannerVisible(page);

    let checkpoint = runtime.checkpoint();
    await acceptCouponBanner(page);
    await expectViewportRelativeCouponIndicator(page);
    await expectNoCouponBanner(page);
    await expectDiscountedPrices(page, '#sessionGrid', 1);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-accept-sessions-discount', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/`);
    await page.locator('#how-we-work').scrollIntoViewIfNeeded();
    await expectViewportRelativeCouponIndicator(page);
    await expectNoCouponBanner(page);
    await expectDiscountedPrices(page, '#how-we-work', 2);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-discount-home', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/evenings.html`);
    await expectViewportRelativeCouponIndicator(page);
    await expectDiscountedPrices(page, '#events-grid', 1);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-discount-evenings', testInfo);

    checkpoint = runtime.checkpoint();
    await removeCouponFromIndicator(page);
    await expect(page.locator('[data-coupon-indicator]')).toHaveCount(0);
    await expectStandardPrices(page, '#events-grid', 1);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-remove-evenings', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await scrollSessionsBannerIntoView(page);
    await expect(page.locator('[data-coupon-indicator]')).toHaveCount(0);
    await expectCouponBannerVisible(page);
    await expectStandardPrices(page, '#sessionGrid', 1);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-remove-sessions', testInfo);
  });

  test('@mobile Israel visitor can accept the banner, see discounted pricing, then remove it and restore standard prices', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    await prepareIsraelVisitor(page);

    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await scrollSessionsBannerIntoView(page);
    await expectCouponBannerVisible(page);

    let checkpoint = runtime.checkpoint();
    await acceptCouponBanner(page);
    await expectViewportRelativeCouponIndicator(page);
    await expectNoCouponBanner(page);
    await expectDiscountedPrices(page, '#sessionGrid', 1);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-accept-sessions-discount-mobile', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/`);
    await page.locator('#how-we-work').scrollIntoViewIfNeeded();
    await expectViewportRelativeCouponIndicator(page);
    await expectNoCouponBanner(page);
    await expectDiscountedPrices(page, '#how-we-work', 2);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-discount-home-mobile', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/evenings.html`);
    await expectViewportRelativeCouponIndicator(page);
    await expectDiscountedPrices(page, '#events-grid', 1);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-discount-evenings-mobile', testInfo);

    checkpoint = runtime.checkpoint();
    await removeCouponFromIndicator(page);
    await expect(page.locator('[data-coupon-indicator]')).toHaveCount(0);
    await expectStandardPrices(page, '#events-grid', 1);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-remove-evenings-mobile', testInfo);
  });
});
