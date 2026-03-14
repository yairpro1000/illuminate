import { expect, test, type Page } from '@playwright/test';
import {
  SITE_BASE_URL,
  clickFirstAvailableSlot,
  expectManageStatus,
  fillContactDetails,
  getEvents,
  makeScenarioEmail,
  waitForBookingArtifacts,
} from './support/api';
import { attachRuntimeMonitor } from './support/runtime';

async function assertSlotPresence(page: Page, dateYmd: string, timeLabel: string, expected: 'present' | 'absent') {
  const dateButton = page.locator(`[data-date="${dateYmd}"]`);
  await expect(dateButton).toHaveCount(1);

  if (expected === 'absent' && await dateButton.isDisabled()) {
    return;
  }

  await dateButton.click();
  await page.waitForTimeout(100);

  const slot = page.locator('.time-slot', { hasText: timeLabel });
  if (expected === 'present') {
    await expect(slot).toHaveCount(1);
  } else {
    await expect(slot).toHaveCount(0);
  }
}

test.describe('P4 core booking flows', () => {
  test('free intro flow confirms, manage link opens, slot disappears, cancel returns slot', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p4-intro');

    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await page.locator('a.btn[href*="book.html?type=intro"]').first().click();
    await expect(page).toHaveURL(/\/book\.html\?type=intro/);

    let checkpoint = runtime.checkpoint();
    const chosenSlot = await clickFirstAvailableSlot(page);
    await fillContactDetails(page, {
      firstName: 'P4',
      lastName: 'Intro',
      email,
      phone: '',
    });
    await page.locator('button[data-submit]').click();
    await expect(page.locator('.confirmation__title')).toContainText('Booking received');
    await runtime.assertNoNewIssues(checkpoint, 'intro-booking-submit', testInfo);

    const pendingArtifacts = await waitForBookingArtifacts(email);
    expect(pendingArtifacts.links.confirm_url).toBeTruthy();

    checkpoint = runtime.checkpoint();
    await page.goto(pendingArtifacts.links.confirm_url!);
    await expect(page.locator('.confirm-title')).toContainText('Confirmed');
    await runtime.assertNoNewIssues(checkpoint, 'intro-confirm-page', testInfo);

    const confirmedArtifacts = await expectManageStatus(email, 'CONFIRMED');

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/book.html?type=intro`);
    await assertSlotPresence(page, chosenSlot.dateYmd, chosenSlot.timeLabel, 'absent');
    await runtime.assertNoNewIssues(checkpoint, 'intro-slot-removed-after-confirm', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(confirmedArtifacts.links.manage_url);
    await expect(page.locator('#cancel-btn')).toBeVisible();
    await page.locator('#cancel-btn').click();
    await page.locator('#cancel-yes').click();
    await expect(page.locator('.manage-title')).toContainText('Cancelled');
    await runtime.assertNoNewIssues(checkpoint, 'intro-manage-cancel', testInfo);

    await expectManageStatus(email, 'CANCELED');

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/book.html?type=intro`);
    await assertSlotPresence(page, chosenSlot.dateYmd, chosenSlot.timeLabel, 'present');
    await runtime.assertNoNewIssues(checkpoint, 'intro-slot-restored-after-cancel', testInfo);
  });

  test('paid 1:1 pay-now flow reaches mock checkout and payment-success recovery', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p4-pay-now');

    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await page.locator('a.btn[href*="book.html?type=session&offer="]').first().click();
    await expect(page).toHaveURL(/\/book\.html\?type=session/);

    let checkpoint = runtime.checkpoint();
    await clickFirstAvailableSlot(page);
    await fillContactDetails(page, {
      firstName: 'P4',
      lastName: 'PayNow',
      email,
      phone: '+41790000000',
    });
    await page.locator('[data-payment="pay-now"]').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('button[data-submit]').click();
    await page.waitForURL(/\/dev-pay\?session_id=/);
    await page.locator('#btn-success').click();
    await page.waitForURL(/\/payment-success(\.html)?\?session_id=/);
    await expect(page.locator('.result-title')).toContainText(/Payment confirmed|Payment received/);
    await runtime.assertNoNewIssues(checkpoint, 'pay-now-session-success', testInfo);

    const paidArtifacts = await waitForBookingArtifacts(email);
    expect(paidArtifacts.payment?.session_id).toBeTruthy();
    expect(['CONFIRMED', 'COMPLETED']).toContain(paidArtifacts.booking.status);
  });

  test('free evening registration confirms through tokenized flow', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p4-evening-free');
    const freeEvent = (await getEvents()).find((event) =>
      event &&
      event.is_paid === false &&
      event.render &&
      event.render.public_registration_open === true,
    );

    expect(freeEvent, 'Expected at least one free public event for P4').toBeTruthy();

    await page.goto(`${SITE_BASE_URL}/evenings.html`);
    await page.locator(`a.btn[href*="eventSlug=${freeEvent.slug}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/book\\.html\\?.*eventSlug=${freeEvent.slug}`));

    let checkpoint = runtime.checkpoint();
    await fillContactDetails(page, {
      firstName: 'P4',
      lastName: 'EveningFree',
      email,
      phone: '+41790000000',
    });
    await page.locator('button[data-submit]').click();
    await expect(page.locator('.confirmation__title')).toContainText('Registration received');
    await runtime.assertNoNewIssues(checkpoint, 'free-evening-submit', testInfo);

    const artifacts = await waitForBookingArtifacts(email);
    expect(artifacts.links.confirm_url).toBeTruthy();

    checkpoint = runtime.checkpoint();
    await page.goto(artifacts.links.confirm_url!);
    await expect(page.locator('.confirm-title')).toContainText('Confirmed');
    await runtime.assertNoNewIssues(checkpoint, 'free-evening-confirm', testInfo);

    await expectManageStatus(email, 'CONFIRMED');
  });

  test('paid evening registration reaches mock checkout and confirms after success', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p4-evening-paid');
    const paidEvent = (await getEvents()).find((event) =>
      event &&
      event.is_paid === true &&
      event.render &&
      event.render.public_registration_open === true,
    );

    expect(paidEvent, 'Expected at least one paid public event for P4').toBeTruthy();

    await page.goto(`${SITE_BASE_URL}/evenings.html`);
    await page.locator(`a.btn[href*="eventSlug=${paidEvent.slug}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/book\\.html\\?.*eventSlug=${paidEvent.slug}`));

    let checkpoint = runtime.checkpoint();
    await fillContactDetails(page, {
      firstName: 'P4',
      lastName: 'EveningPaid',
      email,
      phone: '',
    });
    await page.locator('button[data-submit]').click();
    await page.waitForURL(/\/dev-pay\?session_id=/);
    await page.locator('#btn-success').click();
    await page.waitForURL(/\/payment-success(\.html)?\?session_id=/);
    await expect(page.locator('.result-title')).toContainText(/Payment confirmed|Payment received/);
    await runtime.assertNoNewIssues(checkpoint, 'paid-evening-success', testInfo);

    const artifacts = await waitForBookingArtifacts(email);
    expect(artifacts.payment?.session_id).toBeTruthy();
    expect(['CONFIRMED', 'COMPLETED']).toContain(artifacts.booking.status);
  });
});
