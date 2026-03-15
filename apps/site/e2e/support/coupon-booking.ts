import { expect, type Page } from '@playwright/test';
import { acceptCouponBanner, clearAppliedCouponState, expectCouponBannerVisible, expectViewportRelativeCouponIndicator, forceVisitorCountry, removeCouponFromIndicator } from './coupon';

export const ISRAEL_COUPON_CODE = 'ISRAEL';

export async function prepareIsraelCouponVisitor(page: Page): Promise<void> {
  await clearAppliedCouponState(page);
  await forceVisitorCountry(page, 'IL');
}

export async function scrollSessionsBannerIntoView(page: Page): Promise<void> {
  await page.locator('#session-types').scrollIntoViewIfNeeded();
}

export async function applyIsraelCouponFromSessionsBanner(page: Page): Promise<void> {
  await scrollSessionsBannerIntoView(page);
  await expectCouponBannerVisible(page);
  await acceptCouponBanner(page);
  await expectViewportRelativeCouponIndicator(page);
}

export async function removeIsraelCouponFromIndicator(page: Page): Promise<void> {
  await removeCouponFromIndicator(page);
  await expect(page.locator('[data-coupon-indicator]')).toHaveCount(0);
}

export async function applyIsraelCouponOnReview(page: Page): Promise<void> {
  const input = page.locator('[data-coupon-input]').first();
  await expect(input).toBeVisible();
  await input.fill(ISRAEL_COUPON_CODE);
  await page.locator('[data-coupon-review-apply]').first().click();
  await expect(page.locator('.coupon-review__applied')).toContainText(ISRAEL_COUPON_CODE);
}

export async function expectReviewDiscountSummary(page: Page, amounts: { baseChf: number; finalChf: number }): Promise<void> {
  const review = page.locator('.review-table');
  await expect(review.locator('.coupon-price__old').first()).toContainText(String(amounts.baseChf).replace(/\.0$/, ''));
  await expect(review.locator('.coupon-price__new').first()).toContainText(String(amounts.finalChf).replace(/\.0$/, ''));
}
