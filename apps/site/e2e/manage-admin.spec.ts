import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN_BASE_URL,
  SITE_BASE_URL,
  clickFirstAvailableSlot,
  expectManageStatus,
  fillContactDetails,
  makeScenarioEmail,
  waitForBookingArtifacts,
} from './support/api';
import { attachRuntimeMonitor } from './support/runtime';

async function createConfirmedIntroBooking(page: Page, email: string, testInfo: Parameters<ReturnType<typeof attachRuntimeMonitor>['assertNoNewIssues']>[2]) {
  const runtime = attachRuntimeMonitor(page);

  await page.goto(`${SITE_BASE_URL}/sessions.html`);
  await page.locator('a.btn[href*="book.html?type=intro"]').first().click();
  await expect(page).toHaveURL(/\/book(?:\.html)?\?type=intro/);

  let checkpoint = runtime.checkpoint();
  await clickFirstAvailableSlot(page);
  await fillContactDetails(page, {
    firstName: 'P4',
    lastName: 'Manage',
    email,
    phone: '',
  });
  await page.locator('button[data-submit]').click();
  await expect(page.locator('.confirmation__title')).toContainText('Booking received');
  await runtime.assertNoNewIssues(checkpoint, 'manage-admin-create-intro', testInfo);

  const pendingArtifacts = await waitForBookingArtifacts(email);
  expect(pendingArtifacts.links.confirm_url).toBeTruthy();

  checkpoint = runtime.checkpoint();
  await page.goto(pendingArtifacts.links.confirm_url!);
  await expect(page.locator('.confirm-title')).toContainText('Confirmed');
  await runtime.assertNoNewIssues(checkpoint, 'manage-admin-confirm-intro', testInfo);

  return expectManageStatus(email, 'CONFIRMED');
}

async function chooseReplacementSlot(page: Page): Promise<void> {
  const pickFromCurrentDayView = async (): Promise<boolean> => {
    const slots = page.locator('.time-slot');
    const emptyState = page.locator('.time-slots-empty');

    if (await slots.count()) {
      await slots.first().click();
      return true;
    }

    if (await emptyState.count()) {
      await page.getByRole('button', { name: /Back to calendar/i }).click();
      return false;
    }

    return false;
  };

  if (await pickFromCurrentDayView()) return;

  await page.waitForSelector('.cal-day--available:not([disabled])', { timeout: 15000 });
  const availableDays = page.locator('.cal-day--available:not([disabled])');
  const dayCount = await availableDays.count();
  expect(dayCount).toBeGreaterThan(0);

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    await availableDays.nth(dayIndex).click();
    const slots = page.locator('.time-slot');
    const emptyState = page.locator('.time-slots-empty');
    await expect
      .poll(async () => {
        if (await slots.count()) return 'slots';
        if (await emptyState.count()) return 'empty';
        return 'pending';
      }, {
        timeout: 5000,
        message: 'Expected either replacement slots or the no-times empty state after choosing a day',
      })
      .not.toBe('pending');

    if (await emptyState.count()) continue;

    const slotCount = await slots.count();
    if (slotCount === 0) continue;
    await slots.first().click();
    return;
  }

  throw new Error('No replacement slot available for reschedule after checking all available days');
}

async function advanceRescheduleToSubmit(page: Page): Promise<void> {
  for (let safety = 0; safety < 5; safety += 1) {
    const submitButton = page.locator('button[data-submit]');
    if (await submitButton.count()) return;

    const continueButton = page.getByRole('button', { name: /Continue/i });
    if (await continueButton.count()) {
      await continueButton.click();
      continue;
    }

    throw new Error('Reschedule flow did not expose a submit button');
  }

  throw new Error('Reschedule flow exceeded expected step count');
}

test.describe('P4 manage and admin interactions', () => {
  test('manage link reschedules an eligible 1:1 booking', async ({ page }, testInfo) => {
    const email = makeScenarioEmail('p4-reschedule');
    const artifacts = await createConfirmedIntroBooking(page, email, testInfo);
    const originalStartsAt = artifacts.booking.starts_at;
    const runtime = attachRuntimeMonitor(page);

    const checkpoint = runtime.checkpoint();
    await page.goto(artifacts.links.manage_url);
    await expect(page.locator('.manage-title')).toContainText('Your Booking');
    await expect(page.getByRole('link', { name: 'Reschedule' })).toBeVisible();
    await page.getByRole('link', { name: 'Reschedule' }).click();
    await expect(page).toHaveURL(/\/book(?:\.html)?\?.*mode=reschedule/);

    await chooseReplacementSlot(page);
    await advanceRescheduleToSubmit(page);
    await page.locator('button[data-submit]').click();
    await expect(page.locator('.confirmation__title')).toContainText('Booking rescheduled');
    await runtime.assertNoNewIssues(checkpoint, 'manage-reschedule-submit', testInfo);

    const updated = await expectManageStatus(email, 'CONFIRMED');
    expect(updated.booking.starts_at).not.toBe(originalStartsAt);
  });

  test('admin can edit booking notes on a live session booking', async ({ browser, page }, testInfo) => {
    const email = makeScenarioEmail('p4-admin-edit');
    const artifacts = await createConfirmedIntroBooking(page, email, testInfo);
    const noteText = `P4 note ${Date.now()}`;

    const adminPage = await browser.newPage();
    const runtime = attachRuntimeMonitor(adminPage);
    const bookingDate = artifacts.booking.starts_at.slice(0, 10);

    const checkpoint = runtime.checkpoint();
    await adminPage.goto(`${ADMIN_BASE_URL}/index.html`);
    await adminPage.selectOption('#source', 'session');
    await adminPage.fill('#date', bookingDate);
    await adminPage.click('#loadRows');
    await adminPage.fill('#searchInput', email);

    const targetRow = adminPage.locator('#rowsBody tr', { hasText: email }).first();
    await expect(targetRow).toBeVisible();
    await targetRow.click();

    await expect(adminPage.locator('#editOverlay')).not.toHaveClass(/hidden/);
    await adminPage.fill('#editNotes', noteText);
    await adminPage.click('#editSave');
    await expect(adminPage.locator('#rowsBody tr', { hasText: noteText }).first()).toBeVisible();
    await runtime.assertNoNewIssues(checkpoint, 'admin-edit-booking-notes', testInfo);

    await adminPage.close();
  });
});
