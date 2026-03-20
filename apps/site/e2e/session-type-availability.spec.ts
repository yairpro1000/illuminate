import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  ADMIN_BASE_URL,
  SITE_BASE_URL,
  cancelBookingByManageUrl,
  createAdminSessionType,
  createPayLaterBookingForSlot,
  ensureAntiBotMock,
  ensureEmailMock,
  ensurePaymentsMock,
  getAdminSessionTypeDetail,
  getSlots,
  makeScenarioEmail,
  updateAdminSessionType,
  waitForBookingArtifacts,
  type PublicSlot,
} from './support/api';
import { attachRuntimeMonitor } from './support/runtime';

const BOOKING_CAP_ERROR_TEXT = 'This offer has reached its weekly booking limit for the selected week.';
const EXPECTED_CAP_SUBMIT_ISSUES = [
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
    messageIncludes: '[Book] Submission error: Error: This offer has reached its weekly booking limit for the selected week.',
    urlIncludes: '/js/book.js',
  },
  {
    kind: 'console' as const,
    messageIncludes: '"eventType":"request_failure"',
    urlIncludes: '/js/client.js',
  },
  {
    kind: 'console' as const,
    messageIncludes: '"eventType":"handled_exception"',
    urlIncludes: '/js/client.js',
  },
];

function formatTimeLabel(iso: string, timezone = 'Europe/Zurich'): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(iso));
}

function localDateInfo(iso: string, timezone = 'Europe/Zurich'): { date: string; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(iso));

  const year = parts.find((part) => part.type === 'year')?.value ?? '2000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
  return { date: `${year}-${month}-${day}`, weekday };
}

function shiftIsoDate(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function weekStartDateForSlot(slot: PublicSlot, timezone = 'Europe/Zurich'): string {
  const local = localDateInfo(slot.start, timezone);
  const weekdayIndex = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(local.weekday);
  return shiftIsoDate(local.date, -Math.max(weekdayIndex, 0));
}

function fromTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function futureDateString(monthsAhead = 3): string {
  const next = new Date();
  next.setMonth(next.getMonth() + monthsAhead);
  return next.toISOString().slice(0, 10);
}

function uniqueOfferIdentity(prefix: string): { title: string; slug: string } {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    title: `E2E ${prefix} ${id}`,
    slug: `e2e-${prefix}-${id}`,
  };
}

async function attachCheckpointScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    contentType: 'image/png',
    body: await page.screenshot({ fullPage: true }),
  });
}

async function waitForAdminStatusReady(page: Page, matcher: RegExp): Promise<void> {
  await page.waitForFunction((matcherSource) => {
    const status = document.querySelector('#status');
    const text = status && status.textContent ? status.textContent.trim() : '';
    if (!text || /^loading/i.test(text)) return false;
    return new RegExp(matcherSource, 'i').test(text);
  }, matcher.source);
}

async function waitForOfferModalReady(page: Page): Promise<void> {
  await expect(page.locator('#stOverlay')).not.toHaveClass(/hidden/);
  await page.waitForFunction(() => {
    const overlay = document.querySelector('#stOverlay');
    const msg = document.querySelector('#stEditMsg');
    const overrideButtons = document.querySelectorAll('#stOverridesBody [data-override-week]');
    return !!overlay
      && !overlay.classList.contains('hidden')
      && !/loading availability/i.test((msg && msg.textContent) || '')
      && overrideButtons.length > 0;
  });
}

async function openSessionTypeEditor(page: Page, _id: string, title: string): Promise<void> {
  await page.goto(`${ADMIN_BASE_URL}/session-types.html`);
  await waitForAdminStatusReady(page, /ready/i);
  await page.fill('#searchInput', title);
  const row = page.locator('#stBody tr', { hasText: title }).first();
  await expect(row).toBeVisible();
  await row.click();
  await waitForOfferModalReady(page);
}

async function configureDedicatedAvailabilityInUi(page: Page, weeklyLimit: number): Promise<void> {
  await page.selectOption('#stFAvailabilityMode', 'dedicated');
  await page.fill('#stFAvailabilityTimezone', 'Europe/Zurich');
  await page.fill('#stFWeeklyLimit', String(weeklyLimit));
  await page.fill('#stFSlotStep', '60');

  for (let count = await page.locator('#stWindowsBody select[data-window-field="weekday_iso"]').count(); count < 2; count += 1) {
    await page.click('#stAddWindow');
  }

  await page.selectOption('#stWindowsBody tr:nth-of-type(1) select[data-window-field="weekday_iso"]', '4');
  await page.fill('#stWindowsBody tr:nth-of-type(1) input[data-window-field="start_local_time"]', '11:00');
  await page.fill('#stWindowsBody tr:nth-of-type(1) input[data-window-field="end_local_time"]', '13:00');

  await page.selectOption('#stWindowsBody tr:nth-of-type(2) select[data-window-field="weekday_iso"]', '5');
  await page.fill('#stWindowsBody tr:nth-of-type(2) input[data-window-field="start_local_time"]', '11:00');
  await page.fill('#stWindowsBody tr:nth-of-type(2) input[data-window-field="end_local_time"]', '16:00');

  await page.click('#stSave');
  await expect(page.locator('#stOverlay')).toHaveClass(/hidden/);
  await waitForAdminStatusReady(page, /ready/i);
}

interface ConfigurableOffer {
  id: string;
  title: string;
  slug: string;
  shortDescription: string;
  description: string;
  durationMinutes: number;
  price: number;
  currency: string;
  sortOrder: number;
}

async function createConfigurableOffer(): Promise<ConfigurableOffer> {
  const { title, slug } = uniqueOfferIdentity('availability');
  const shortDescription = 'E2E availability coverage';
  const description = 'Created by Playwright for session-type availability coverage.';
  const durationMinutes = 60;
  const price = 180;
  const currency = 'CHF';
  const sortOrder = 9999;
  const created = await createAdminSessionType({
    title,
    slug,
    short_description: shortDescription,
    description,
    duration_minutes: durationMinutes,
    price,
    currency,
    status: 'active',
    sort_order: sortOrder,
  });

  return {
    id: String(created.id),
    title,
    slug,
    shortDescription,
    description,
    durationMinutes,
    price,
    currency,
    sortOrder,
  };
}

async function configureOfferThroughAdminUi(
  page: Page,
  id: string,
  title: string,
  weeklyLimit: number,
  testInfo: TestInfo,
): Promise<void> {
  const runtime = attachRuntimeMonitor(page);
  await openSessionTypeEditor(page, id, title);
  const checkpoint = runtime.checkpoint();
  await configureDedicatedAvailabilityInUi(page, weeklyLimit);
  await runtime.assertNoNewIssues(checkpoint, 'admin-save-dedicated-availability', testInfo);
  await attachCheckpointScreenshot(page, testInfo, 'admin-availability-saved');
}

async function fetchOfferSlots(slug: string): Promise<PublicSlot[]> {
  return getSlots(fromTodayDateString(), futureDateString(), 'session', 'Europe/Zurich', { offerSlug: slug });
}

function findTargetWeeks(slots: PublicSlot[]): {
  cappedWeekStart: string;
  cappedWeekSlots: PublicSlot[];
  forceClosedWeekStart: string;
  forceClosedWeekSlots: PublicSlot[];
} {
  const slotsByWeek = new Map<string, PublicSlot[]>();
  for (const slot of slots) {
    const weekStart = weekStartDateForSlot(slot);
    const next = slotsByWeek.get(weekStart) ?? [];
    next.push(slot);
    slotsByWeek.set(weekStart, next);
  }

  const weeks = [...slotsByWeek.entries()]
    .map(([weekStart, weekSlots]) => ({
      weekStart,
      weekSlots: weekSlots.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
    }))
    .filter((entry) => entry.weekSlots.length >= 2)
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  if (weeks.length < 2) {
    throw new Error(`Expected at least two upcoming configured weeks, found ${weeks.length}`);
  }

  return {
    cappedWeekStart: weeks[0].weekStart,
    cappedWeekSlots: weeks[0].weekSlots,
    forceClosedWeekStart: weeks[1].weekStart,
    forceClosedWeekSlots: weeks[1].weekSlots,
  };
}

async function gotoOfferBookingPage(page: Page, slug: string): Promise<void> {
  await page.goto(`${SITE_BASE_URL}/book.html?type=session&offer=${encodeURIComponent(slug)}`);
  await expect(page).toHaveURL(new RegExp(`/book(?:\\.html)?\\?type=session&offer=${slug}`));
  await page.waitForSelector('.cal-grid');
}

async function openCalendarDate(page: Page, dateYmd: string): Promise<void> {
  for (let attempts = 0; attempts < 6; attempts += 1) {
    const dateButton = page.locator(`[data-date="${dateYmd}"]`);
    if (await dateButton.count()) {
      return;
    }
    const nextButton = page.locator('[data-cal-next]');
    if (await nextButton.isDisabled()) break;
    await nextButton.click();
  }
  throw new Error(`Could not find calendar date ${dateYmd}`);
}

async function expectDateAvailability(page: Page, dateYmd: string, available: boolean): Promise<void> {
  await openCalendarDate(page, dateYmd);
  const dateButton = page.locator(`[data-date="${dateYmd}"]`);
  if (available) {
    await expect(dateButton).toHaveClass(/cal-day--available/);
    await expect(dateButton).toBeEnabled();
  } else {
    await expect(dateButton).not.toHaveClass(/cal-day--available/);
    await expect(dateButton).toBeDisabled();
  }
}

async function collectVisibleSlotLabels(page: Page, dateYmd: string): Promise<string[]> {
  await openCalendarDate(page, dateYmd);
  const dateButton = page.locator(`[data-date="${dateYmd}"]`);
  await dateButton.click();
  const labels = await page.locator('.time-slot').allInnerTexts();
  return labels.map((label) => label.trim()).filter(Boolean);
}

async function fillSessionDetailsAndReachReview(page: Page, email: string): Promise<void> {
  await page.fill('#f-first-name', 'P4');
  await page.fill('#f-last-name', 'Availability');
  await page.fill('#f-email', email);
  await page.fill('#f-phone', '+41790000000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('[data-payment="pay-later"]').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('button[data-submit]')).toContainText('Confirm Booking');
}

async function createPendingSessionBooking(slot: PublicSlot, slug: string, cleanupManageUrls: string[]): Promise<void> {
  const email = makeScenarioEmail('p4-week-cap');
  await createPayLaterBookingForSlot(slot, email, { offerSlug: slug });
  const artifacts = await waitForBookingArtifacts(email);
  cleanupManageUrls.push(artifacts.links.manage_url);
}

async function setWeekOverrideThroughAdminUi(
  page: Page,
  id: string,
  title: string,
  weekStartDate: string,
  action: 'Open' | 'Close',
  testInfo: TestInfo,
): Promise<void> {
  const runtime = attachRuntimeMonitor(page);
  await openSessionTypeEditor(page, id, title);
  const checkpoint = runtime.checkpoint();
  const row = page.locator('#stOverridesBody tr', { hasText: weekStartDate }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: action }).click();
  await expect(page.locator('#stEditMsg')).toContainText('Override saved.');
  await runtime.assertNoNewIssues(checkpoint, `admin-week-override-${action.toLowerCase()}`, testInfo);
  await attachCheckpointScreenshot(page, testInfo, `admin-override-${action.toLowerCase()}-${weekStartDate}`);
}

async function cleanupScenarioData(offer: ConfigurableOffer, cleanupManageUrls: string[]): Promise<void> {
  await Promise.all(cleanupManageUrls.map((manageUrl) => cancelBookingByManageUrl(manageUrl).catch(() => undefined)));
  await updateAdminSessionType(offer.id, {
    title: offer.title,
    slug: offer.slug,
    short_description: offer.shortDescription,
    description: offer.description,
    duration_minutes: offer.durationMinutes,
    price: offer.price,
    currency: offer.currency,
    status: 'hidden',
    sort_order: offer.sortOrder,
    image_key: null,
    image_alt: null,
    drive_file_id: null,
  }).catch(() => undefined);
}

test.describe('session-type availability UI', () => {
  test.beforeAll(async () => {
    await ensureEmailMock();
    await ensureAntiBotMock();
    await ensurePaymentsMock();
  });

  test('admin saves dedicated availability and public booking shows only configured windows', async ({ page }, testInfo) => {
    const offer = await createConfigurableOffer();
    const { id, title, slug } = offer;
    try {
      await configureOfferThroughAdminUi(page, id, title, 2, testInfo);

      await openSessionTypeEditor(page, id, title);
      await expect(page.locator('#stFAvailabilityMode')).toHaveValue('dedicated');
      await expect(page.locator('#stFAvailabilityTimezone')).toHaveValue('Europe/Zurich');
      await expect(page.locator('#stFWeeklyLimit')).toHaveValue('2');
      await expect(page.locator('#stFSlotStep')).toHaveValue('60');
      await expect(page.locator('#stWindowsBody tr')).toHaveCount(2);
      await attachCheckpointScreenshot(page, testInfo, 'admin-availability-editor-reloaded');

      const detail = await getAdminSessionTypeDetail(id);
      expect(detail.availability.mode).toBe('dedicated');
      expect(detail.availability.weekly_booking_limit).toBe(2);
      expect(detail.availability.windows).toEqual(expect.arrayContaining([
        expect.objectContaining({ weekday_iso: 4, start_local_time: '11:00:00', end_local_time: '13:00:00' }),
        expect.objectContaining({ weekday_iso: 5, start_local_time: '11:00:00', end_local_time: '16:00:00' }),
      ]));

      const slots = await fetchOfferSlots(slug);
      expect(slots.length).toBeGreaterThan(0);
      const thursdaySlots = slots.filter((slot) => localDateInfo(slot.start).weekday === 'Thu');
      const fridaySlots = slots.filter((slot) => localDateInfo(slot.start).weekday === 'Fri');
      expect(thursdaySlots.length).toBeGreaterThan(0);
      expect(fridaySlots.length).toBeGreaterThan(0);

      const expectedThursdayLabels = thursdaySlots
        .filter((slot) => localDateInfo(slot.start).date === localDateInfo(thursdaySlots[0].start).date)
        .map((slot) => formatTimeLabel(slot.start));
      const expectedFridayLabels = fridaySlots
        .filter((slot) => localDateInfo(slot.start).date === localDateInfo(fridaySlots[0].start).date)
        .map((slot) => formatTimeLabel(slot.start));

      const runtime = attachRuntimeMonitor(page);
      const checkpoint = runtime.checkpoint();
      await gotoOfferBookingPage(page, slug);
      expect(await collectVisibleSlotLabels(page, localDateInfo(thursdaySlots[0].start).date)).toEqual(expectedThursdayLabels);
      await gotoOfferBookingPage(page, slug);
      expect(await collectVisibleSlotLabels(page, localDateInfo(fridaySlots[0].start).date)).toEqual(expectedFridayLabels);
      await runtime.assertNoNewIssues(checkpoint, 'public-configured-slot-windows', testInfo);
      await attachCheckpointScreenshot(page, testInfo, 'public-configured-slot-windows');
    } finally {
      await cleanupScenarioData(offer, []);
    }
  });

  test('weekly cap plus admin force-open and force-closed overrides change public availability', async ({ page }, testInfo) => {
    const offer = await createConfigurableOffer();
    const { id, title, slug } = offer;
    const cleanupManageUrls: string[] = [];
    try {
      await configureOfferThroughAdminUi(page, id, title, 2, testInfo);

      const slots = await fetchOfferSlots(slug);
      const targetWeeks = findTargetWeeks(slots);
      const cappedDateSet = [...new Set(targetWeeks.cappedWeekSlots.map((slot) => localDateInfo(slot.start).date))];
      const forceClosedDateSet = [...new Set(targetWeeks.forceClosedWeekSlots.map((slot) => localDateInfo(slot.start).date))];

      await createPendingSessionBooking(targetWeeks.cappedWeekSlots[0], slug, cleanupManageUrls);
      await createPendingSessionBooking(targetWeeks.cappedWeekSlots[1], slug, cleanupManageUrls);

      const runtime = attachRuntimeMonitor(page);
      let checkpoint = runtime.checkpoint();
      await gotoOfferBookingPage(page, slug);
      for (const dateYmd of cappedDateSet) {
        await expectDateAvailability(page, dateYmd, false);
      }
      await runtime.assertNoNewIssues(checkpoint, 'public-week-cap-closes-dates', testInfo);
      await attachCheckpointScreenshot(page, testInfo, 'public-capped-week-closed');

      await setWeekOverrideThroughAdminUi(page, id, title, targetWeeks.cappedWeekStart, 'Open', testInfo);

      checkpoint = runtime.checkpoint();
      await gotoOfferBookingPage(page, slug);
      for (const dateYmd of cappedDateSet) {
        await expectDateAvailability(page, dateYmd, true);
      }
      await runtime.assertNoNewIssues(checkpoint, 'public-force-open-reopens-dates', testInfo);
      await attachCheckpointScreenshot(page, testInfo, 'public-force-open-week');

      await setWeekOverrideThroughAdminUi(page, id, title, targetWeeks.forceClosedWeekStart, 'Close', testInfo);

      checkpoint = runtime.checkpoint();
      await gotoOfferBookingPage(page, slug);
      for (const dateYmd of forceClosedDateSet) {
        await expectDateAvailability(page, dateYmd, false);
      }
      await runtime.assertNoNewIssues(checkpoint, 'public-force-closed-hides-dates', testInfo);
      await attachCheckpointScreenshot(page, testInfo, 'public-force-closed-week');

      const detail = await getAdminSessionTypeDetail(id);
      const openWeek = detail.availability.upcoming_weeks.find((week) => week.week_start_date === targetWeeks.cappedWeekStart);
      const closedWeek = detail.availability.upcoming_weeks.find((week) => week.week_start_date === targetWeeks.forceClosedWeekStart);
      expect(openWeek?.mode).toBe('FORCE_OPEN');
      expect(closedWeek?.mode).toBe('FORCE_CLOSED');
    } finally {
      await cleanupScenarioData(offer, cleanupManageUrls);
    }
  });

  test('submit-time capacity enforcement blocks a stale review after the week fills up', async ({ page }, testInfo) => {
    const offer = await createConfigurableOffer();
    const { id, title, slug } = offer;
    const cleanupManageUrls: string[] = [];
    try {
      await configureOfferThroughAdminUi(page, id, title, 2, testInfo);

      const slots = await fetchOfferSlots(slug);
      const { cappedWeekSlots } = findTargetWeeks(slots);
      expect(cappedWeekSlots.length).toBeGreaterThanOrEqual(3);

      const runtime = attachRuntimeMonitor(page);
      await gotoOfferBookingPage(page, slug);
      await openCalendarDate(page, localDateInfo(cappedWeekSlots[2].start).date);
      await page.locator(`[data-date="${localDateInfo(cappedWeekSlots[2].start).date}"]`).click();
      await page.locator('.time-slot', { hasText: formatTimeLabel(cappedWeekSlots[2].start) }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await fillSessionDetailsAndReachReview(page, makeScenarioEmail('p4-stale-cap'));

      await createPendingSessionBooking(cappedWeekSlots[0], slug, cleanupManageUrls);
      await createPendingSessionBooking(cappedWeekSlots[1], slug, cleanupManageUrls);

      const checkpoint = runtime.checkpoint();
      await page.locator('button[data-submit]').click();
      await expect(page.getByRole('alert')).toContainText(BOOKING_CAP_ERROR_TEXT);
      await expect(page.locator('button[data-submit]')).toContainText('Confirm Booking');
      await runtime.assertNoNewIssues(checkpoint, 'submit-time-week-cap-denial', testInfo, {
        allow: EXPECTED_CAP_SUBMIT_ISSUES,
      });
      await attachCheckpointScreenshot(page, testInfo, 'submit-time-week-cap-denial');
    } finally {
      await cleanupScenarioData(offer, cleanupManageUrls);
    }
  });
});
