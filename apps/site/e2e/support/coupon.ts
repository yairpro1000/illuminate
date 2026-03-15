import { expect, type Locator, type Page } from '@playwright/test';

export async function clearAppliedCouponState(page: Page): Promise<void> {
  await page.goto('about:blank');
  await page.evaluate(() => {
    try {
      window.localStorage.removeItem('couponCode');
    } catch (_) {}
  });
}

export async function forceVisitorCountry(page: Page, countryCode: string): Promise<void> {
  await page.route(/\/api\/config$/, async (route) => {
    const upstream = await route.fetch();
    const body = await upstream.json();
    const patched = {
      ...body,
      visitor: {
        ...(body && body.visitor ? body.visitor : {}),
        country: countryCode,
      },
    };
    await route.fulfill({
      response: upstream,
      contentType: 'application/json',
      body: JSON.stringify(patched),
    });
  });
}

export function couponBanner(page: Page): Locator {
  return page.locator('[data-coupon-suggestion]').first();
}

export function couponIndicator(page: Page): Locator {
  return page.locator('[data-coupon-indicator]').first();
}

export async function expectNoCouponBanner(page: Page): Promise<void> {
  await expect(page.locator('[data-coupon-suggestion]')).toHaveCount(0);
}

export async function expectCouponBannerVisible(page: Page): Promise<void> {
  await expect(couponBanner(page)).toBeVisible();
  await expect(couponBanner(page).locator('[data-coupon-apply="ISRAEL"]')).toBeVisible();
}

export async function acceptCouponBanner(page: Page): Promise<void> {
  await couponBanner(page).locator('[data-coupon-apply="ISRAEL"]').click();
}

export async function expectCouponIndicatorVisible(page: Page): Promise<void> {
  await expect(couponIndicator(page)).toBeVisible();
  await expect(couponIndicator(page)).toContainText('Israel discount applied');
}

export async function expectViewportRelativeCouponIndicator(page: Page): Promise<void> {
  await expectCouponIndicatorVisible(page);
  await expect.poll(async () => page.evaluate(() => {
    const indicator = document.querySelector('[data-coupon-indicator]');
    if (!indicator) return 'missing';
    const style = window.getComputedStyle(indicator);
    return JSON.stringify({
      position: style.position,
      right: style.right,
      bottom: style.bottom,
      parentTag: indicator.parentElement ? indicator.parentElement.tagName : 'missing',
    });
  }), {
    message: 'Expected coupon indicator to stay anchored to the viewport',
  }).toBe(JSON.stringify({ position: 'fixed', right: '16px', bottom: '16px', parentTag: 'BODY' }));

  const before = await couponIndicator(page).boundingBox();
  if (!before) throw new Error('Coupon indicator is missing a bounding box before scroll');

  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(200);

  const after = await couponIndicator(page).boundingBox();
  if (!after) throw new Error('Coupon indicator is missing a bounding box after scroll');

  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
}

export async function removeCouponFromIndicator(page: Page): Promise<void> {
  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await couponIndicator(page).locator('[data-coupon-remove="true"]').click();
}

export async function expectDiscountedPrices(
  page: Page,
  scopeSelector: string,
  minimumCount = 1,
): Promise<void> {
  const scope = page.locator(scopeSelector);
  await expect(scope).toBeVisible();
  await expect.poll(async () => scope.locator('.coupon-price--discounted').count(), {
    message: `Expected at least ${minimumCount} discounted prices in ${scopeSelector}`,
  }).toBeGreaterThanOrEqual(minimumCount);
  await expect(scope.locator('.coupon-price__old').first()).toBeVisible();
  await expect(scope.locator('.coupon-price__new').first()).toBeVisible();
}

export async function expectStandardPrices(
  page: Page,
  scopeSelector: string,
  minimumCount = 1,
): Promise<void> {
  const scope = page.locator(scopeSelector);
  await expect(scope).toBeVisible();
  const standard = scope.locator('.coupon-price--standard, .coupon-price--free');
  await expect.poll(async () => standard.count(), {
    message: `Expected at least ${minimumCount} standard prices in ${scopeSelector}`,
  }).toBeGreaterThanOrEqual(minimumCount);
  await expect(scope.locator('.coupon-price--discounted')).toHaveCount(0);
}

export async function expectStickyCouponBanner(page: Page): Promise<void> {
  const banner = couponBanner(page);
  await expect(banner).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const element = document.querySelector('[data-coupon-suggestion]');
    return element ? window.getComputedStyle(element).position : 'missing';
  }), {
    message: 'Expected coupon banner to use sticky positioning',
  }).toBe('sticky');

  const before = await banner.boundingBox();
  if (!before) throw new Error('Coupon banner is missing a bounding box before scroll');

  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(200);

  const after = await banner.boundingBox();
  if (!after) throw new Error('Coupon banner is missing a bounding box after scroll');

  expect(Math.abs(after.y - before.y)).toBeLessThan(220);
}
