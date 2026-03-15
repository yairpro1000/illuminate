import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  SITE_BASE_URL,
  cancelBookingByManageUrl,
  clickFirstAvailableSlot,
  createPayNowBookingForSlot,
  ensureAntiBotMock,
  ensureEmailMock,
  expectManageStatus,
  fillContactDetails,
  getEvents,
  getSlots,
  makeScenarioEmail,
  simulatePaymentSuccess,
  waitForBookingArtifacts,
  type PublicSlot,
} from './support/api';
import { createConfirmedIntroBookingViaUi } from './support/intro-booking';
import { expectInlineMockEmailPreview } from './support/mock-email-preview';
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

async function waitForSlotPresence(
  page: Page,
  url: string,
  dateYmd: string,
  timeLabel: string,
  expected: 'present' | 'absent',
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const slots = await getSlots('2026-03-15', '2026-07-15', 'intro');
      const match = slots.some((slot) =>
        slot.start.slice(0, 10) === dateYmd
        && new Date(slot.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) === timeLabel.slice(0, 5),
      );
      if ((expected === 'present' && match) || (expected === 'absent' && !match)) {
        await page.goto(url);
        await assertSlotPresence(page, dateYmd, timeLabel, expected);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(1000);
  }

  throw lastError instanceof Error ? lastError : new Error(`Slot did not become ${expected} within ${timeoutMs}ms`);
}

async function createConfirmedIntroBooking(page: Page, email: string, testInfo: Parameters<ReturnType<typeof attachRuntimeMonitor>['assertNoNewIssues']>[2]) {
  return createConfirmedIntroBookingViaUi(page, {
    email,
    firstName: 'P4',
    lastName: 'Manage',
    phone: '',
    createIssueLabel: 'mobile-create-intro',
    confirmIssueLabel: 'mobile-confirm-intro',
    testInfo,
  });
}

async function chooseReplacementSlot(page: Page): Promise<void> {
  const waitForRescheduleState = async (): Promise<'day-slots' | 'day-empty' | 'calendar'> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await page.locator('.time-slot').count()) return 'day-slots';
      if (await page.locator('.time-slots-empty').count()) return 'day-empty';
      if (await page.locator('.cal-day--available:not([disabled])').count()) return 'calendar';
      await page.waitForTimeout(100);
    }

    throw new Error('Expected reschedule flow to show day slots, day empty-state, or available calendar days');
  };

  const initialState = await waitForRescheduleState();

  if (initialState === 'day-slots') {
    await page.locator('.time-slot').first().click();
    return;
  }

  if (initialState === 'day-empty') {
    await page.getByRole('button', { name: /Back to calendar/i }).click();
  }

  await page.waitForSelector('.cal-day--available:not([disabled])', { timeout: 15_000 });
  const availableDays = page.locator('.cal-day--available:not([disabled])');
  const dayCount = await availableDays.count();

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    await availableDays.nth(dayIndex).click();
    const slots = page.locator('.time-slot');
    const emptyState = page.locator('.time-slots-empty');
    await expect
      .poll(async () => {
        if (await slots.count()) return 'slots';
        if (await emptyState.count()) return 'empty';
        return 'pending';
      }, { timeout: 5_000 })
      .not.toBe('pending');

    if (await emptyState.count()) continue;
    if (await slots.count()) {
      await slots.first().click();
      return;
    }
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

async function createConfirmedSessionBookingForSlot(slot: PublicSlot, email: string): Promise<Awaited<ReturnType<typeof waitForBookingArtifacts>>> {
  await createPayNowBookingForSlot(slot, email);
  const pending = await waitForBookingArtifacts(email);
  const sessionId = pending.payment?.session_id;
  expect(sessionId).toBeTruthy();
  await simulatePaymentSuccess(sessionId!);
  return expectManageStatus(email, 'CONFIRMED');
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
  const byDay = new Map<string, PublicSlot[]>();
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
    if (await page.locator('iframe.mock-email-preview__frame').count()) return 'success';
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
  const checkpoint = runtime.checkpoint();
  await page.getByRole('button', { name: 'Choose another time' }).click();
  const repicked = await chooseAlternativeIntroSlot(page, staleSlot);
  await expect(page.locator('#f-first-name')).toHaveValue('P4');
  await expect(page.locator('#f-last-name')).toHaveValue('Race');
  await expect(page.locator('#f-email')).toHaveValue(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('button[data-submit]').click();
  await expectInlineMockEmailPreview(page, {
    title: 'Booking received',
    frameText: 'Please confirm your session booking.',
    actionName: 'Confirm booking',
    actionHref: /confirm\.html\?token=/,
  });
  await runtime.assertNoNewIssues(checkpoint, 'mobile-contention-loser-rebook-success', testInfo);

  const loserArtifacts = await waitForBookingArtifacts(email);
  expect(loserArtifacts.booking.starts_at.slice(0, 10)).toBe(repicked.dateYmd);
  await page.goto(loserArtifacts.links.confirm_url!);
  await expectInlineMockEmailPreview(page, {
    title: 'Confirmed!',
    frameText: /confirmed|Manage booking|Complete payment/i,
  });
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
  await expectInlineMockEmailPreview(page, {
    title: 'Message sent',
    frameText: 'A slot conflict occurred. Please help me choose another time.',
  });
}

async function cleanupConfirmedIntro(email: string): Promise<void> {
  const artifacts = await expectManageStatus(email, 'CONFIRMED');
  await cancelBookingByManageUrl(artifacts.links.manage_url);
  await expectManageStatus(email, 'CANCELED');
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

async function newMobileSession(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const captureVideos = process.env.E2E_CAPTURE_MULTIUSER_VIDEO === '1';
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    ...(captureVideos ? { recordVideo: { dir: 'test-results/mobile-capture-videos' } } : {}),
  });
  const page = await context.newPage();
  return { context, page };
}

test.describe('@mobile P4 mobile regression', () => {
  test.beforeAll(async () => {
    await ensureEmailMock();
    await ensureAntiBotMock();
  });

  test('@mobile free intro flow confirms, manage link opens, slot disappears, cancel returns slot', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p4m-intro');

    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await page.locator('a.btn[href*="book.html?type=intro"]').first().click();
    await expect(page).toHaveURL(/\/book(?:\.html)?\?type=intro/);

    let checkpoint = runtime.checkpoint();
    const chosenSlot = await clickFirstAvailableSlot(page);
    await fillContactDetails(page, { firstName: 'P4', lastName: 'Intro', email, phone: '' });
    await page.locator('button[data-submit]').click();
    await expectInlineMockEmailPreview(page, {
      title: 'Booking received',
      frameText: 'Please confirm your session booking.',
      actionName: 'Confirm booking',
      actionHref: /confirm\.html\?token=/,
    });
    await runtime.assertNoNewIssues(checkpoint, 'mobile-intro-booking-submit', testInfo);

    const pendingArtifacts = await waitForBookingArtifacts(email);
    checkpoint = runtime.checkpoint();
    await page.goto(pendingArtifacts.links.confirm_url!);
    await expectInlineMockEmailPreview(page, {
      title: 'Confirmed!',
      frameText: /confirmed|Manage booking|Complete payment/i,
    });
    await runtime.assertNoNewIssues(checkpoint, 'mobile-intro-confirm-page', testInfo);

    const confirmedArtifacts = await expectManageStatus(email, 'CONFIRMED');

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/book?type=intro`);
    await assertSlotPresence(page, chosenSlot.dateYmd, chosenSlot.timeLabel, 'absent');
    await runtime.assertNoNewIssues(checkpoint, 'mobile-intro-slot-removed-after-confirm', testInfo);
    await page.waitForLoadState('networkidle');

    checkpoint = runtime.checkpoint();
    await page.goto(confirmedArtifacts.links.manage_url);
    await expect(page.locator('#cancel-btn')).toBeVisible();
    await page.locator('#cancel-btn').click();
    await page.locator('#cancel-yes').click();
    await expectInlineMockEmailPreview(page, {
      title: 'Cancelled',
      frameText: 'Your session has been cancelled.',
    });
    await runtime.assertNoNewIssues(checkpoint, 'mobile-intro-manage-cancel', testInfo);

    await expectManageStatus(email, 'CANCELED');
    checkpoint = runtime.checkpoint();
    await waitForSlotPresence(page, `${SITE_BASE_URL}/book?type=intro`, chosenSlot.dateYmd, chosenSlot.timeLabel, 'present');
    await runtime.assertNoNewIssues(checkpoint, 'mobile-intro-slot-restored-after-cancel', testInfo);
  });

  test('@mobile paid 1:1 pay-now flow reaches mock checkout and payment-success recovery', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p4m-pay-now');

    await page.goto(`${SITE_BASE_URL}/sessions.html`);
    await page.locator('a.btn[href*="book.html?type=session&offer="]').first().click();
    await expect(page).toHaveURL(/\/book(?:\.html)?\?type=session/);

    const checkpoint = runtime.checkpoint();
    const chosenSlot = await clickFirstAvailableSlot(page);
    await fillContactDetails(page, { firstName: 'P4', lastName: 'PayNow', email, phone: '+41790000000' });
    await page.locator('[data-payment="pay-now"]').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.step-eyebrow')).toContainText('Review your booking');
    await expect(page.locator('.review-table')).toContainText(chosenSlot.timeLabel);
    await expect(page.locator('.review-table')).toContainText('Price');
    await expect(page.locator('button[data-submit]')).toContainText('Proceed to Payment');
    await page.locator('button[data-submit]').click();
    await page.waitForURL(/\/dev-pay\?session_id=/);
    await page.locator('#btn-success').click();
    await page.waitForURL(/\/payment-success(\.html)?\?session_id=/);
    await expect(page.locator('.result-title')).toContainText(/Payment confirmed!|Payment received/);
    await expect(page.locator('.result-msg')).toContainText(/booking is confirmed|payment is being finalized|email is delayed/i);
    await expect(page.getByRole('link', { name: /Manage booking|Back to homepage/i })).toHaveAttribute('href', /manage\.html\?token=|index\.html/);
    await runtime.assertNoNewIssues(checkpoint, 'mobile-pay-now-session-success', testInfo);
  });

  test('@mobile free evening registration confirms through tokenized flow', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p4m-evening-free');
    const freeEvent = (await getEvents()).find((event) => event && event.is_paid === false && event.render?.public_registration_open === true);
    expect(freeEvent).toBeTruthy();

    await page.goto(`${SITE_BASE_URL}/evenings.html`);
    await page.locator(`a.btn[href*="eventSlug=${freeEvent.slug}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/book(?:\\.html)?\\?.*eventSlug=${freeEvent.slug}`));

    let checkpoint = runtime.checkpoint();
    await fillContactDetails(page, { firstName: 'P4', lastName: 'EveningFree', email, phone: '+41790000000' });
    await page.locator('button[data-submit]').click();
    await expectInlineMockEmailPreview(page, {
      title: 'Registration received',
      frameText: 'Please confirm your spot.',
      actionName: 'Confirm my spot',
      actionHref: /confirm\.html\?token=/,
    });
    await runtime.assertNoNewIssues(checkpoint, 'mobile-free-evening-submit', testInfo);

    const artifacts = await waitForBookingArtifacts(email);
    checkpoint = runtime.checkpoint();
    await page.goto(artifacts.links.confirm_url!);
    await expectInlineMockEmailPreview(page, {
      title: 'Confirmed!',
      frameText: /confirmed|Manage booking/i,
    });
    await runtime.assertNoNewIssues(checkpoint, 'mobile-free-evening-confirm', testInfo);
  });

  test('@mobile paid evening registration reaches mock checkout and confirms after success', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p4m-evening-paid');
    const paidEvent = (await getEvents()).find((event) => event && event.is_paid === true && event.render?.public_registration_open === true);
    test.skip(!paidEvent, 'No paid public event is currently available in the deployed target environment.');

    await page.goto(`${SITE_BASE_URL}/evenings.html`);
    await page.locator(`a.btn[href*="eventSlug=${paidEvent.slug}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/book(?:\\.html)?\\?.*eventSlug=${paidEvent.slug}`));

    const checkpoint = runtime.checkpoint();
    await fillContactDetails(page, { firstName: 'P4', lastName: 'EveningPaid', email, phone: '' });
    await page.locator('button[data-submit]').click();
    await page.waitForURL(/\/dev-pay\?session_id=/);
    await page.locator('#btn-success').click();
    await page.waitForURL(/\/payment-success(\.html)?\?session_id=/);
    await expectInlineMockEmailPreview(page, {
      title: /Confirmed!|Payment confirmed|Payment received/,
      frameText: /confirmed|Manage booking/i,
      actionName: /Manage booking/i,
      actionHref: /manage\.html\?token=/,
    });
    await runtime.assertNoNewIssues(checkpoint, 'mobile-paid-evening-success', testInfo);
  });

  test('@mobile contact form valid submit', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = makeScenarioEmail('p4m-contact');

    await page.goto(`${SITE_BASE_URL}/contact.html`);
    const checkpoint = runtime.checkpoint();
    await page.locator('#contact-first-name').fill('P4');
    await page.locator('#contact-last-name').fill('Mobile');
    await page.locator('#contact-email').fill(email);
    await page.locator('#contact-topic').selectOption({ label: 'Question about 1:1 sessions' });
    await page.locator('#contact-message').fill('Testing valid mobile contact submission.');
    await page.locator('#contact-submit-btn').click();
    await expectInlineMockEmailPreview(page, {
      title: 'Message sent',
      frameText: 'Testing valid mobile contact submission.',
    });
    await runtime.assertNoNewIssues(checkpoint, 'mobile-contact-submit', testInfo);
  });

  test('@mobile manage link reschedules an eligible 1:1 booking', async ({ page }, testInfo) => {
    const email = makeScenarioEmail('p4m-reschedule');
    const artifacts = await createConfirmedIntroBooking(page, email, testInfo);
    const originalStartsAt = artifacts.booking.starts_at;
    const runtime = attachRuntimeMonitor(page);

    const checkpoint = runtime.checkpoint();
    await page.goto(artifacts.links.manage_url);
    await expect(page.getByRole('link', { name: 'Reschedule' })).toBeVisible();
    await page.getByRole('link', { name: 'Reschedule' }).click();
    await chooseReplacementSlot(page);
    await advanceRescheduleToSubmit(page);
    await page.locator('button[data-submit]').click();
    await expect(page.locator('.confirmation__title')).toContainText('Booking rescheduled');
    await runtime.assertNoNewIssues(checkpoint, 'mobile-manage-reschedule-submit', testInfo);

    const updated = await expectManageStatus(email, 'CONFIRMED');
    expect(updated.booking.starts_at).not.toBe(originalStartsAt);
  });

  test('@mobile a second user loses cleanly when submitting a stale intro slot after the first user confirms it', async ({ browser }, testInfo) => {
    const sessionA = await newMobileSession(browser);
    const sessionB = await newMobileSession(browser);
    const pageA = sessionA.page;
    const pageB = sessionB.page;
    const runtimeB = attachRuntimeMonitor(pageB);
    const winnerEmail = makeScenarioEmail('p4m-stale-winner');
    const loserEmail = makeScenarioEmail('p4m-stale-loser');

    try {
      const chosen = await createPreparedIntroDraft(pageA, winnerEmail);
      await createPreparedIntroDraftForSlot(pageB, loserEmail, chosen);

      await pageA.locator('button[data-submit]').click();
      await expectInlineMockEmailPreview(pageA, {
        title: 'Booking received',
        frameText: 'Please confirm your session booking.',
        actionName: 'Confirm booking',
        actionHref: /confirm\.html\?token=/,
      });

      const winnerArtifacts = await waitForBookingArtifacts(winnerEmail);
      await pageA.goto(winnerArtifacts.links.confirm_url!);
      await expectInlineMockEmailPreview(pageA, {
        title: 'Confirmed!',
        frameText: /confirmed|Manage booking|Complete payment/i,
      });

      const loserCheckpoint = runtimeB.checkpoint();
      await pageB.locator('button[data-submit]').click();
      expect(await waitForIntroOutcome(pageB)).toBe('slot-lost');
      await runtimeB.assertNoNewIssues(loserCheckpoint, 'mobile-contention-stale-loser', testInfo, { allow: EXPECTED_SLOT_CONFLICT_ISSUES });
      await recoverLoserToSuccessfulIntroBooking(pageB, runtimeB, chosen, loserEmail, testInfo);

      await cleanupConfirmedIntro(winnerEmail);
      await cleanupConfirmedIntro(loserEmail);
    } finally {
      await sessionA.context.close();
      await sessionB.context.close();
    }
  });

  test('@mobile a stale-slot loser can switch to contact and successfully send the public contact form', async ({ browser }, testInfo) => {
    const sessionA = await newMobileSession(browser);
    const sessionB = await newMobileSession(browser);
    const pageA = sessionA.page;
    const pageB = sessionB.page;
    const runtimeB = attachRuntimeMonitor(pageB);
    const winnerEmail = makeScenarioEmail('p4m-contact-winner');
    const contactEmail = makeScenarioEmail('p4m-contact-loser');

    try {
      const chosen = await createPreparedIntroDraft(pageA, winnerEmail);
      await createPreparedIntroDraftForSlot(pageB, contactEmail, chosen);

      await pageA.locator('button[data-submit]').click();
      await expectInlineMockEmailPreview(pageA, {
        title: 'Booking received',
        frameText: 'Please confirm your session booking.',
        actionName: 'Confirm booking',
        actionHref: /confirm\.html\?token=/,
      });

      const winnerArtifacts = await waitForBookingArtifacts(winnerEmail);
      await pageA.goto(winnerArtifacts.links.confirm_url!);
      await expectInlineMockEmailPreview(pageA, {
        title: 'Confirmed!',
        frameText: /confirmed|Manage booking|Complete payment/i,
      });

      const loserCheckpoint = runtimeB.checkpoint();
      await pageB.locator('button[data-submit]').click();
      expect(await waitForIntroOutcome(pageB)).toBe('slot-lost');
      await runtimeB.assertNoNewIssues(loserCheckpoint, 'mobile-contention-contact-loser', testInfo, { allow: EXPECTED_SLOT_CONFLICT_ISSUES });

      await expect(pageB.locator('.booking-recovery__title')).toContainText('That time was just taken');
      const contactCheckpoint = runtimeB.checkpoint();
      await pageB.getByRole('link', { name: 'Contact Yair directly' }).click();
      await submitContactForm(pageB, contactEmail);
      await runtimeB.assertNoNewIssues(contactCheckpoint, 'mobile-contention-contact-submit', testInfo);

      await cleanupConfirmedIntro(winnerEmail);
    } finally {
      await sessionA.context.close();
      await sessionB.context.close();
    }
  });

  test('@mobile two users racing for the same intro slot produce one winner and one clean slot-taken failure', async ({ browser }, testInfo) => {
    const sessionA = await newMobileSession(browser);
    const sessionB = await newMobileSession(browser);
    const pageA = sessionA.page;
    const pageB = sessionB.page;
    const runtimeA = attachRuntimeMonitor(pageA);
    const runtimeB = attachRuntimeMonitor(pageB);
    const emailA = makeScenarioEmail('p4m-race-a');
    const emailB = makeScenarioEmail('p4m-race-b');

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
      const winnerPage = outcomeA === 'success' ? pageA : pageB;
      await winnerPage.goto(winnerArtifacts.links.confirm_url!);
      await expectInlineMockEmailPreview(winnerPage, {
        title: 'Confirmed!',
        frameText: /confirmed|Manage booking|Complete payment/i,
      });
      await winnerRuntime.assertNoNewIssues(winnerCheckpoint, 'mobile-contention-race-winner', testInfo);
      await loserRuntime.assertNoNewIssues(loserCheckpoint, 'mobile-contention-race-loser', testInfo, { allow: EXPECTED_SLOT_CONFLICT_ISSUES });

      const loserPage = outcomeA === 'slot-lost' ? pageA : pageB;
      await recoverLoserToSuccessfulIntroBooking(loserPage, loserRuntime, chosen, loserEmail, testInfo);
      await cleanupConfirmedIntro(winnerEmail);
      await cleanupConfirmedIntro(loserEmail);
    } finally {
      await sessionA.context.close();
      await sessionB.context.close();
    }
  });
});
