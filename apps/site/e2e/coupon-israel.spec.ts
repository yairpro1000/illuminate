import { expect, test } from '@playwright/test';
import { SITE_BASE_URL, ensureEmailMock } from './support/api';
import {
  clearAppliedCouponState,
  couponBanner,
  expectCouponBannerVisible,
  expectNoCouponBanner,
  expectStickyCouponBanner,
  forceVisitorCountry,
} from './support/coupon';
import { attachRuntimeMonitor } from './support/runtime';

async function prepareIsraelVisitor(page: import('@playwright/test').Page): Promise<void> {
  await clearAppliedCouponState(page);
  await forceVisitorCountry(page, 'IL');
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
    await expectCouponBannerVisible(page);
    await runtime.assertNoNewIssues(checkpoint, 'coupon-sessions-banner-mobile', testInfo);
  });
});
