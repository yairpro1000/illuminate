import { expect, type Page } from '@playwright/test';
import {
  SITE_BASE_URL,
  clickFirstAvailableSlot,
  expectManageStatus,
  fillContactDetails,
  waitForBookingArtifacts,
} from './api';
import { expectInlineMockEmailPreview } from './mock-email-preview';
import { attachRuntimeMonitor } from './runtime';

type RuntimeTestInfo = Parameters<ReturnType<typeof attachRuntimeMonitor>['assertNoNewIssues']>[2];

interface CreateConfirmedIntroBookingOptions {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  createIssueLabel?: string;
  confirmIssueLabel?: string;
  testInfo?: RuntimeTestInfo;
}

async function waitForIntroSubmitOutcome(page: Page): Promise<'success' | 'slot-lost'> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await page.locator('iframe.mock-email-preview__frame').count()) return 'success';
    const recovery = page.locator('.booking-recovery__title').first();
    if (await recovery.count()) {
      const text = (await recovery.textContent()) || '';
      if (text.includes('That time was just taken')) return 'slot-lost';
    }
    await page.waitForTimeout(200);
  }

  throw new Error('Timed out waiting for intro booking submit outcome');
}

async function chooseAlternativeIntroSlot(
  page: Page,
  staleSlot: { dateYmd: string; timeLabel: string },
): Promise<void> {
  await page.waitForLoadState('networkidle');
  await Promise.race([
    page.locator('.time-slot').first().waitFor({ state: 'visible', timeout: 5_000 }),
    page.locator(`[data-date="${staleSlot.dateYmd}"]`).first().waitFor({ state: 'visible', timeout: 5_000 }),
  ]).catch(() => {});

  const visibleSlots = page.locator('.time-slot');
  const visibleSlotCount = await visibleSlots.count();
  if (visibleSlotCount > 0) {
    for (let i = 0; i < visibleSlotCount; i += 1) {
      const slot = visibleSlots.nth(i);
      const timeLabel = (await slot.innerText()).trim();
      if (timeLabel === staleSlot.timeLabel) continue;
      await slot.click();
      await page.getByRole('button', { name: 'Continue' }).click();
      return;
    }
  }

  const staleDateButton = page.locator(`[data-date="${staleSlot.dateYmd}"]`);
  if (await staleDateButton.count()) {
    await staleDateButton.click();
    const slots = page.locator('.time-slot');
    const slotCount = await slots.count();
    for (let i = 0; i < slotCount; i += 1) {
      const slot = slots.nth(i);
      const timeLabel = (await slot.innerText()).trim();
      if (timeLabel === staleSlot.timeLabel) continue;
      await slot.click();
      await page.getByRole('button', { name: 'Continue' }).click();
      return;
    }
  }

  const availableDays = page.locator('.cal-day--available:not([disabled])');
  const dayCount = await availableDays.count();
  for (let i = 0; i < dayCount; i += 1) {
    const day = availableDays.nth(i);
    const dateYmd = await day.getAttribute('data-date');
    if (!dateYmd) continue;
    await day.click();
    const slots = page.locator('.time-slot');
    const slotCount = await slots.count();
    if (slotCount === 0) {
      const back = page.getByRole('button', { name: /Back to calendar/i });
      if (await back.count()) await back.click();
      continue;
    }
    await slots.first().click();
    await page.getByRole('button', { name: 'Continue' }).click();
    return;
  }

  throw new Error('No alternative intro slot available after conflict');
}

async function submitIntroBookingAttempt(
  page: Page,
  firstName: string,
  lastName: string,
  email: string,
  phone: string,
): Promise<'success' | 'restart'> {
  const chosenSlot = await clickFirstAvailableSlot(page);
  await fillContactDetails(page, { firstName, lastName, email, phone });
  await page.locator('button[data-submit]').click();

  if (await waitForIntroSubmitOutcome(page) === 'success') {
    return 'success';
  }

  await expect(page.locator('.booking-recovery__title')).toContainText('That time was just taken');
  await page.getByRole('button', { name: 'Choose another time' }).click();
  try {
    await chooseAlternativeIntroSlot(page, chosenSlot);
  } catch (error) {
    if (error instanceof Error && error.message.includes('No alternative intro slot available')) {
      return 'restart';
    }
    throw error;
  }
  await expect(page.locator('#f-first-name')).toHaveValue(firstName);
  await expect(page.locator('#f-last-name')).toHaveValue(lastName);
  await expect(page.locator('#f-email')).toHaveValue(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('button[data-submit]')).toBeVisible();
  await page.locator('button[data-submit]').click();
  await expect(waitForIntroSubmitOutcome(page)).resolves.toBe('success');
  return 'success';
}

export async function createConfirmedIntroBookingViaUi(
  page: Page,
  {
    email,
    firstName = 'P4',
    lastName = 'Manage',
    phone = '',
    createIssueLabel,
    confirmIssueLabel,
    testInfo,
  }: CreateConfirmedIntroBookingOptions,
) {
  const runtime = attachRuntimeMonitor(page);
  let checkpoint = runtime.checkpoint();
  let outcome: 'success' | 'restart' = 'restart';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await page.locator('a.btn[href*="book.html?type=intro"]').first().click();
    await expect(page).toHaveURL(/\/book(?:\.html)?\?type=intro/);
    outcome = await submitIntroBookingAttempt(page, firstName, lastName, email, phone);
    if (outcome === 'success') break;
  }
  if (outcome !== 'success') {
    throw new Error('Unable to complete intro booking after repeated slot contention');
  }

  await expectInlineMockEmailPreview(page, {
    title: 'Booking received',
    frameText: 'Please confirm your session booking.',
    actionName: 'Confirm booking',
    actionHref: /\/confirm\.html\?token=/,
  });
  if (testInfo && createIssueLabel) {
    await runtime.assertNoNewIssues(checkpoint, createIssueLabel, testInfo);
  }

  const pendingArtifacts = await waitForBookingArtifacts(email);
  expect(pendingArtifacts.links.confirm_url).toBeTruthy();

  checkpoint = runtime.checkpoint();
  await page.goto(pendingArtifacts.links.confirm_url!);
  await expectInlineMockEmailPreview(page, {
    title: 'Confirmed!',
    frameText: /confirmed|Manage booking|Complete payment/i,
  });
  if (testInfo && confirmIssueLabel) {
    await runtime.assertNoNewIssues(checkpoint, confirmIssueLabel, testInfo);
  }

  return expectManageStatus(email, 'CONFIRMED');
}
