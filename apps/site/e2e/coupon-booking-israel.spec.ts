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
import { expectInlineMockEmailPreview } from './support/mock-email-preview';
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

async function openSessionOfferWithAvailability(page: Page): Promise<void> {
  const links = page.locator('a.btn[href*="book.html?type=session&offer="]');
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    await links.nth(index).click();
    await expect(page).toHaveURL(/\/book(?:\.html)?\?type=session/);
    const availableDays = page.locator('.cal-day--available:not([disabled])');
    try {
      await availableDays.first().waitFor({ state: 'visible', timeout: 5_000 });
      return;
    } catch (_) {
      // Try the next offer if this one never exposes a selectable day.
    }
    await page.goto(`${SITE_BASE_URL}/sessions.html`);
  }
  throw new Error('No paid session offer with available dates is currently available');
}

async function completePayNowFromReview(page: Page): Promise<void> {
  await page.locator('button[data-submit]').click();
  const outcome = await waitForPayNowSubmitOutcome(page);
  if (outcome === 'slot-lost') {
    throw new Error('slot_lost_before_checkout');
  }
  await page.locator('#btn-success').click();
  await page.waitForURL(/\/payment-success(\.html)?\?session_id=/);
  await expect(page.locator('.result-title')).toContainText(/Payment confirmed!|Payment received/);
}

async function waitForPayNowSubmitOutcome(page: Page): Promise<'checkout' | 'slot-lost'> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (/\/dev-pay\?session_id=/.test(page.url())) return 'checkout';
    const recovery = page.locator('.booking-recovery__title').first();
    if (await recovery.count()) {
      const text = (await recovery.textContent()) || '';
      if (text.includes('That time was just taken')) return 'slot-lost';
    }
    await page.waitForTimeout(200);
  }
  throw new Error('Timed out waiting for pay-now checkout or slot-loss recovery');
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

async function waitForDeferredSubmitOutcome(page: Page): Promise<'preview' | 'slot-lost'> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await page.locator('iframe.mock-email-preview__frame').count()) return 'preview';
    const recovery = page.locator('.booking-recovery__title').first();
    if (await recovery.count()) {
      const text = (await recovery.textContent()) || '';
      if (text.includes('That time was just taken')) return 'slot-lost';
    }
    await page.waitForTimeout(200);
  }
  throw new Error('Timed out waiting for deferred booking preview or slot-loss recovery');
}

async function completePayLaterFromReview(page: Page): Promise<void> {
  await page.locator('button[data-submit]').click();
  const outcome = await waitForDeferredSubmitOutcome(page);
  if (outcome === 'slot-lost') {
    throw new Error('slot_lost_before_confirmation');
  }
}

async function verifyDiscountedPayLaterArtifacts(
  browserPageFactory: () => Promise<Page>,
  email: string,
  expectedFinalChf: number,
): Promise<void> {
  const pendingArtifacts = await waitForBookingArtifacts(email);
  expect(pendingArtifacts.links.confirm_url).toBeTruthy();
  expect(pendingArtifacts.booking.status).toBe('PENDING');

  const bookingRow = await waitForSupabaseBookingSnapshot(
    pendingArtifacts.booking.id,
    (row) => row.coupon_code === 'ISRAEL' && Number(row.price) === expectedFinalChf,
  );
  expect(bookingRow.coupon_code).toBe('ISRAEL');
  expect(Number(bookingRow.price)).toBe(expectedFinalChf);

  const confirmPage = await browserPageFactory();
  try {
    await confirmPage.goto(pendingArtifacts.links.confirm_url!);
    await expectInlineMockEmailPreview(confirmPage, {
      title: 'Confirmed!',
      frameText: /confirmed|Manage booking|Complete payment/i,
      actionName: /Complete payment/i,
      actionHref: /\/continue-payment\.html\?token=/,
    });
  } finally {
    await confirmPage.close();
  }

  const confirmedArtifacts = await waitForBookingArtifacts(email);
  expect(confirmedArtifacts.booking.status).toBe('CONFIRMED');
  expect(confirmedArtifacts.payment).toBeTruthy();

  const paymentRow = await waitForSupabasePaymentStatus(confirmedArtifacts.booking.id, ['PENDING', 'INVOICE_SENT']);
  expect(Number(paymentRow.amount)).toBe(expectedFinalChf);

  const adminPage = await browserPageFactory();
  try {
    await openAdminBookingRowByEmail(adminPage, email, confirmedArtifacts.booking.starts_at.slice(0, 10), 'session');
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const runtime = attachRuntimeMonitor(page);
      await prepareIsraelCouponVisitor(page);

      let checkpoint = runtime.checkpoint();
      await page.goto(`${SITE_BASE_URL}/sessions.html`);
      await applyIsraelCouponFromSessionsBanner(page);
      await openSessionOfferWithAvailability(page);
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

      try {
        await completePayNowFromReview(page);
      } catch (error) {
        if (error instanceof Error && error.message === 'slot_lost_before_checkout' && attempt < 2) {
          continue;
        }
        throw error;
      }

      await runtime.assertNoNewIssues(checkpoint, 'coupon-banner-pay-now-session', testInfo);
      await verifyDiscountedPayNowArtifacts(browserPageFactory, email, amounts.finalChf);
      return;
    }

    throw new Error('Unable to complete banner-applied pay-now coupon flow after repeated slot contention');
  }

  async function runReviewAppliedPayNowCase(
    page: Page,
    browserPageFactory: () => Promise<Page>,
    email: string,
    testInfo: Parameters<ReturnType<typeof attachRuntimeMonitor>['assertNoNewIssues']>[2],
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const runtime = attachRuntimeMonitor(page);
      await prepareIsraelCouponVisitor(page);

      let checkpoint = runtime.checkpoint();
      await page.goto(`${SITE_BASE_URL}/sessions.html`);
      await applyIsraelCouponFromSessionsBanner(page);
      await removeIsraelCouponFromIndicator(page);
      await openSessionOfferWithAvailability(page);
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

      try {
        await completePayNowFromReview(page);
      } catch (error) {
        if (error instanceof Error && error.message === 'slot_lost_before_checkout' && attempt < 2) {
          continue;
        }
        throw error;
      }

      await runtime.assertNoNewIssues(checkpoint, 'coupon-review-pay-now-session', testInfo);
      await verifyDiscountedPayNowArtifacts(browserPageFactory, email, amounts.finalChf);
      return;
    }

    throw new Error('Unable to complete review-applied pay-now coupon flow after repeated slot contention');
  }

  async function runBannerAppliedPayLaterCase(
    page: Page,
    browserPageFactory: () => Promise<Page>,
    email: string,
    testInfo: Parameters<ReturnType<typeof attachRuntimeMonitor>['assertNoNewIssues']>[2],
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const runtime = attachRuntimeMonitor(page);
      await prepareIsraelCouponVisitor(page);

      const checkpoint = runtime.checkpoint();
      await page.goto(`${SITE_BASE_URL}/sessions.html`);
      await applyIsraelCouponFromSessionsBanner(page);
      await openSessionOfferWithAvailability(page);
      const day = page.locator('.cal-day--available:not([disabled])').first();
      await day.click();
      const slot = page.locator('.time-slot').first();
      await slot.click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillContactDetails(page, {
        firstName: 'P4',
        lastName: 'CouponPayLater',
        email,
        phone: '+41790000000',
      });
      await page.locator('[data-payment="pay-later"]').click();
      await page.getByRole('button', { name: 'Continue' }).click();
      const amounts = await extractReviewCouponAmounts(page);

      try {
        await completePayLaterFromReview(page);
      } catch (error) {
        if (error instanceof Error && error.message === 'slot_lost_before_confirmation' && attempt < 2) {
          continue;
        }
        throw error;
      }

      await expectInlineMockEmailPreview(page, {
        title: 'Booking received',
        frameText: 'Please confirm your session booking.',
        actionName: 'Confirm booking',
        actionHref: /\/confirm\.html\?token=/,
      });
      await runtime.assertNoNewIssues(checkpoint, 'coupon-banner-pay-later-session', testInfo);
      await verifyDiscountedPayLaterArtifacts(browserPageFactory, email, amounts.finalChf);
      return;
    }

    throw new Error('Unable to complete banner-applied pay-later coupon flow after repeated slot contention');
  }

  async function runReviewAppliedPayLaterCase(
    page: Page,
    browserPageFactory: () => Promise<Page>,
    email: string,
    testInfo: Parameters<ReturnType<typeof attachRuntimeMonitor>['assertNoNewIssues']>[2],
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const runtime = attachRuntimeMonitor(page);
      await prepareIsraelCouponVisitor(page);

      const checkpoint = runtime.checkpoint();
      await page.goto(`${SITE_BASE_URL}/sessions.html`);
      await applyIsraelCouponFromSessionsBanner(page);
      await removeIsraelCouponFromIndicator(page);
      await openSessionOfferWithAvailability(page);
      const day = page.locator('.cal-day--available:not([disabled])').first();
      await day.click();
      const slot = page.locator('.time-slot').first();
      await slot.click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillContactDetails(page, {
        firstName: 'P4',
        lastName: 'CouponPayLaterManual',
        email,
        phone: '+41790000000',
      });
      await page.locator('[data-payment="pay-later"]').click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await applyIsraelCouponOnReview(page);
      const amounts = await extractReviewCouponAmounts(page);

      try {
        await completePayLaterFromReview(page);
      } catch (error) {
        if (error instanceof Error && error.message === 'slot_lost_before_confirmation' && attempt < 2) {
          continue;
        }
        throw error;
      }

      await expectInlineMockEmailPreview(page, {
        title: 'Booking received',
        frameText: 'Please confirm your session booking.',
        actionName: 'Confirm booking',
        actionHref: /\/confirm\.html\?token=/,
      });
      await runtime.assertNoNewIssues(checkpoint, 'coupon-review-pay-later-session', testInfo);
      await verifyDiscountedPayLaterArtifacts(browserPageFactory, email, amounts.finalChf);
      return;
    }

    throw new Error('Unable to complete review-applied pay-later coupon flow after repeated slot contention');
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

  test('pay-later session booking keeps Israel discount when applied from sessions banner', async ({ browser, page }, testInfo) => {
    await runBannerAppliedPayLaterCase(page, () => browser.newPage(), makeArtifactSafeEmail('p4-coupon-banner-pay-later'), testInfo);
  });

  test('@mobile pay-later session booking keeps Israel discount when applied from sessions banner', async ({ browser, page }, testInfo) => {
    await runBannerAppliedPayLaterCase(page, () => browser.newPage(), makeArtifactSafeEmail('p4-coupon-banner-pay-later-mobile'), testInfo);
  });

  test('pay-later session booking can remove Israel discount then reapply it manually on review', async ({ browser, page }, testInfo) => {
    await runReviewAppliedPayLaterCase(page, () => browser.newPage(), makeArtifactSafeEmail('p4-coupon-review-pay-later'), testInfo);
  });

  test('@mobile pay-later session booking can remove Israel discount then reapply it manually on review', async ({ browser, page }, testInfo) => {
    await runReviewAppliedPayLaterCase(page, () => browser.newPage(), makeArtifactSafeEmail('p4-coupon-review-pay-later-mobile'), testInfo);
  });
});
