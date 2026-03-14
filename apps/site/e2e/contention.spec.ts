import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  SITE_BASE_URL,
  cancelBookingByManageUrl,
  ensureEmailMock,
  expectManageStatus,
  getSlots,
  makeScenarioEmail,
  waitForBookingArtifacts,
} from './support/api';
import { attachRuntimeMonitor } from './support/runtime';

const EXPECTED_SLOT_CONFLICT_ISSUES = [
  {
    kind: 'http' as const,
    messageIncludes: '-> 409',
    urlIncludes: '/api/bookings/pay-later',
  },
  {
    kind: 'console' as const,
    messageIncludes: 'Failed to load resource: the server responded with a status of 409',
    urlIncludes: '/api/bookings/pay-later',
  },
  {
    kind: 'console' as const,
    messageIncludes: '"eventType":"request_failure"',
    urlIncludes: '/js/client.js',
  },
  {
    kind: 'console' as const,
    messageIncludes: '[Book] Submission error: Error: This slot is no longer available',
    urlIncludes: '/js/book.js',
  },
  {
    kind: 'console' as const,
    messageIncludes: '"eventType":"handled_exception"',
    urlIncludes: '/js/client.js',
  },
];

async function openIntroFlow(page: Page): Promise<void> {
  await page.goto(`${SITE_BASE_URL}/sessions.html`);
  await page.locator('a.btn[href*="book.html?type=intro"]').first().click();
  await expect(page).toHaveURL(/\/book(?:\.html)?\?type=intro/);
}

async function chooseSpecificIntroSlot(page: Page, dateYmd: string, timeLabel: string): Promise<void> {
  await page.locator(`[data-date="${dateYmd}"]`).click();
  await page.locator('.time-slot', { hasText: timeLabel }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function chooseFirstIntroSlot(page: Page): Promise<{ dateYmd: string; timeLabel: string }> {
  const day = page.locator('.cal-day--available:not([disabled])').first();
  const dateYmd = await day.getAttribute('data-date');
  await day.click();
  const slot = page.locator('.time-slot').first();
  const timeLabel = (await slot.innerText()).trim();
  await slot.click();
  await page.getByRole('button', { name: 'Continue' }).click();
  return { dateYmd: dateYmd || '', timeLabel };
}

async function findIntroSlotWithBackup(): Promise<{ dateYmd: string; timeLabel: string }> {
  const from = new Date();
  const to = new Date();
  to.setMonth(to.getMonth() + 4);
  const slots = await getSlots(
    from.toISOString().slice(0, 10),
    to.toISOString().slice(0, 10),
    'intro',
    'Europe/Zurich',
  );

  const byDay = new Map<string, Array<{ start: string; end: string }>>();
  for (const slot of slots) {
    const day = slot.start.slice(0, 10);
    const daySlots = byDay.get(day) || [];
    daySlots.push(slot);
    byDay.set(day, daySlots);
  }

  for (const [dateYmd, daySlots] of byDay.entries()) {
    if (daySlots.length < 2) continue;
    const chosen = daySlots[0];
    const date = new Date(chosen.start);
    const timeLabel = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Europe/Zurich',
    }).format(date);
    return { dateYmd, timeLabel };
  }

  throw new Error('No intro slot day with a backup slot is currently available');
}

async function fillIntroDetailsAndReachReview(page: Page, email: string): Promise<void> {
  await page.locator('#f-first-name').fill('P4');
  await page.locator('#f-last-name').fill('Race');
  await page.locator('#f-email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('button[data-submit]')).toBeVisible();
}

async function waitForIntroOutcome(page: Page): Promise<'success' | 'slot-lost'> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await page.locator('.confirmation__title').count()) return 'success';
    const recovery = page.locator('.booking-recovery__title').first();
    if (await recovery.count()) {
      const text = (await recovery.textContent()) || '';
      if (text.includes('That time was just taken')) return 'slot-lost';
    }
    await page.waitForTimeout(200);
  }
  throw new Error('Timed out waiting for booking contention outcome');
}

async function chooseAlternativeIntroSlot(page: Page, staleSlot: { dateYmd: string; timeLabel: string }): Promise<{ dateYmd: string; timeLabel: string }> {
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
      return { dateYmd: staleSlot.dateYmd, timeLabel };
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
      return { dateYmd: staleSlot.dateYmd, timeLabel };
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
    const slot = slots.first();
    const timeLabel = (await slot.innerText()).trim();
    await slot.click();
    await page.getByRole('button', { name: 'Continue' }).click();
    return { dateYmd, timeLabel };
  }

  throw new Error('No alternative intro slot available after conflict');
}

async function recoverLoserToSuccessfulIntroBooking(
  page: Page,
  runtime: ReturnType<typeof attachRuntimeMonitor>,
  staleSlot: { dateYmd: string; timeLabel: string },
  email: string,
  testInfo: Parameters<ReturnType<typeof attachRuntimeMonitor>['assertNoNewIssues']>[2],
): Promise<void> {
  await expect(page.locator('.booking-recovery__title')).toContainText('That time was just taken');
  await expect(page.locator('.booking-recovery__message')).toContainText('Your details are saved');
  await expect(page.locator('.booking-recovery__stale-slot')).toContainText(staleSlot.timeLabel);
  await expect(page.getByRole('button', { name: 'Choose another time' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm Booking' })).toHaveCount(0);

  const checkpoint = runtime.checkpoint();
  await page.getByRole('button', { name: 'Choose another time' }).click();
  await expect(page).toHaveURL(/\/book(?:\.html)?\?type=intro/);
  const repicked = await chooseAlternativeIntroSlot(page, staleSlot);
  await expect(page.locator('#f-first-name')).toHaveValue('P4');
  await expect(page.locator('#f-last-name')).toHaveValue('Race');
  await expect(page.locator('#f-email')).toHaveValue(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('button[data-submit]')).toBeVisible();
  await page.locator('button[data-submit]').click();
  await expect(page.locator('.confirmation__title')).toContainText('Booking received');
  await runtime.assertNoNewIssues(checkpoint, 'contention-loser-rebook-success', testInfo);

  const loserArtifacts = await waitForBookingArtifacts(email);
  expect(loserArtifacts.booking.starts_at.slice(0, 10)).toBe(repicked.dateYmd);
  expect(loserArtifacts.links.confirm_url).toBeTruthy();
  await page.goto(loserArtifacts.links.confirm_url!);
  await expect(page.locator('.confirm-title')).toContainText('Confirmed');
}

async function cleanupConfirmedIntro(email: string): Promise<void> {
  const artifacts = await expectManageStatus(email, 'CONFIRMED');
  await cancelBookingByManageUrl(artifacts.links.manage_url);
  await expectManageStatus(email, 'CANCELED');
}

async function submitContactForm(page: Page, email: string): Promise<void> {
  await expect(page).toHaveURL(/\/contact(?:\.html)?$/);
  await expect(page.locator('#contact-form')).toBeVisible();
  await page.locator('#contact-first-name').fill('P4');
  await page.locator('#contact-last-name').fill('Race');
  await page.locator('#contact-email').fill(email);
  await page.locator('#contact-topic').selectOption({ label: 'Question about 1:1 sessions' });
  await page.locator('#contact-message').fill('A slot conflict occurred. Please help me choose another time.');
  await page.locator('#contact-submit-btn').click();
  await expect(page.locator('#contact-success')).toBeVisible();
  await expect(page.locator('.contact-success__title')).toContainText('Message sent');
}

async function createPreparedIntroDraft(page: Page, email: string): Promise<{ dateYmd: string; timeLabel: string }> {
  await openIntroFlow(page);
  const preferred = await findIntroSlotWithBackup();
  await chooseSpecificIntroSlot(page, preferred.dateYmd, preferred.timeLabel);
  await fillIntroDetailsAndReachReview(page, email);
  return preferred;
}

async function createPreparedIntroDraftForSlot(page: Page, email: string, slot: { dateYmd: string; timeLabel: string }): Promise<void> {
  await openIntroFlow(page);
  await chooseSpecificIntroSlot(page, slot.dateYmd, slot.timeLabel);
  await fillIntroDetailsAndReachReview(page, email);
}

async function newPage(browser: Browser): Promise<Page> {
  return browser.newPage();
}

test.describe('P4 multi-user slot contention', () => {
  test.beforeAll(async () => {
    await ensureEmailMock();
  });

  test('a second user loses cleanly when submitting a stale intro slot after the first user confirms it', async ({ browser }, testInfo) => {
    const pageA = await newPage(browser);
    const pageB = await newPage(browser);
    const runtimeA = attachRuntimeMonitor(pageA);
    const runtimeB = attachRuntimeMonitor(pageB);
    const winnerEmail = makeScenarioEmail('p4-stale-winner');
    const loserEmail = makeScenarioEmail('p4-stale-loser');

    try {
      const chosen = await createPreparedIntroDraft(pageA, winnerEmail);
      await createPreparedIntroDraftForSlot(pageB, loserEmail, chosen);

      await pageA.locator('button[data-submit]').click();
      await expect(pageA.locator('.confirmation__title')).toContainText('Booking received');

      const winnerArtifacts = await waitForBookingArtifacts(winnerEmail);
      expect(winnerArtifacts.links.confirm_url).toBeTruthy();
      await pageA.goto(winnerArtifacts.links.confirm_url!);
      await expect(pageA.locator('.confirm-title')).toContainText('Confirmed');

      const loserCheckpoint = runtimeB.checkpoint();
      await pageB.locator('button[data-submit]').click();
      expect(await waitForIntroOutcome(pageB)).toBe('slot-lost');
      await runtimeB.assertNoNewIssues(loserCheckpoint, 'contention-stale-loser', testInfo, { allow: EXPECTED_SLOT_CONFLICT_ISSUES });
      await recoverLoserToSuccessfulIntroBooking(pageB, runtimeB, chosen, loserEmail, testInfo);

      await cleanupConfirmedIntro(winnerEmail);
      await cleanupConfirmedIntro(loserEmail);
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });

  test('a stale-slot loser can switch to contact and successfully send the public contact form', async ({ browser }, testInfo) => {
    const pageA = await newPage(browser);
    const pageB = await newPage(browser);
    const runtimeB = attachRuntimeMonitor(pageB);
    const winnerEmail = makeScenarioEmail('p4-contact-winner');
    const contactEmail = makeScenarioEmail('p4-contact-loser');

    try {
      const chosen = await createPreparedIntroDraft(pageA, winnerEmail);
      await createPreparedIntroDraftForSlot(pageB, contactEmail, chosen);

      await pageA.locator('button[data-submit]').click();
      await expect(pageA.locator('.confirmation__title')).toContainText('Booking received');

      const winnerArtifacts = await waitForBookingArtifacts(winnerEmail);
      expect(winnerArtifacts.links.confirm_url).toBeTruthy();
      await pageA.goto(winnerArtifacts.links.confirm_url!);
      await expect(pageA.locator('.confirm-title')).toContainText('Confirmed');

      const loserCheckpoint = runtimeB.checkpoint();
      await pageB.locator('button[data-submit]').click();
      expect(await waitForIntroOutcome(pageB)).toBe('slot-lost');
      await runtimeB.assertNoNewIssues(loserCheckpoint, 'contention-contact-loser', testInfo, { allow: EXPECTED_SLOT_CONFLICT_ISSUES });

      await expect(pageB.locator('.booking-recovery__title')).toContainText('That time was just taken');
      const contactCheckpoint = runtimeB.checkpoint();
      await pageB.getByRole('link', { name: 'Contact Yair directly' }).click();
      await submitContactForm(pageB, contactEmail);
      await runtimeB.assertNoNewIssues(contactCheckpoint, 'contention-contact-submit', testInfo);

      await cleanupConfirmedIntro(winnerEmail);
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });

  test('two users racing for the same intro slot produce one winner and one clean slot-taken failure', async ({ browser }, testInfo) => {
    const pageA = await newPage(browser);
    const pageB = await newPage(browser);
    const runtimeA = attachRuntimeMonitor(pageA);
    const runtimeB = attachRuntimeMonitor(pageB);
    const emailA = makeScenarioEmail('p4-race-a');
    const emailB = makeScenarioEmail('p4-race-b');

    try {
      const chosen = await createPreparedIntroDraft(pageA, emailA);
      await createPreparedIntroDraftForSlot(pageB, emailB, chosen);

      const checkpointA = runtimeA.checkpoint();
      const checkpointB = runtimeB.checkpoint();
      await Promise.all([
        pageA.locator('button[data-submit]').click(),
        pageB.locator('button[data-submit]').click(),
      ]);

      const [outcomeA, outcomeB] = await Promise.all([
        waitForIntroOutcome(pageA),
        waitForIntroOutcome(pageB),
      ]);

      expect([outcomeA, outcomeB].sort()).toEqual(['slot-lost', 'success']);

      const winnerEmail = outcomeA === 'success' ? emailA : emailB;
      const loserEmail = outcomeA === 'slot-lost' ? emailA : emailB;
      const winnerRuntime = outcomeA === 'success' ? runtimeA : runtimeB;
      const loserRuntime = outcomeA === 'slot-lost' ? runtimeA : runtimeB;
      const winnerCheckpoint = outcomeA === 'success' ? checkpointA : checkpointB;
      const loserCheckpoint = outcomeA === 'slot-lost' ? checkpointA : checkpointB;

      const winnerArtifacts = await waitForBookingArtifacts(winnerEmail);
      expect(winnerArtifacts.links.confirm_url).toBeTruthy();
      const winnerPage = outcomeA === 'success' ? pageA : pageB;
      await winnerPage.goto(winnerArtifacts.links.confirm_url!);
      await expect(winnerPage.locator('.confirm-title')).toContainText('Confirmed');
      await winnerRuntime.assertNoNewIssues(winnerCheckpoint, 'contention-race-winner', testInfo);
      await loserRuntime.assertNoNewIssues(loserCheckpoint, 'contention-race-loser', testInfo, { allow: EXPECTED_SLOT_CONFLICT_ISSUES });
      const loserPage = outcomeA === 'slot-lost' ? pageA : pageB;
      await recoverLoserToSuccessfulIntroBooking(loserPage, loserRuntime, chosen, loserEmail, testInfo);
      await cleanupConfirmedIntro(winnerEmail);
      await cleanupConfirmedIntro(loserEmail);
    } finally {
      await pageA.close();
      await pageB.close();
    }
  });
});
