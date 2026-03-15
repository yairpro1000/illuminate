import { expect, type Page, type TestInfo } from '@playwright/test';
import {
  SITE_BASE_URL,
  clickFirstAvailableSlot,
  createLateAccessLink,
  getAdminEventsAll,
  getAdminTimingSettings,
  expectManageStatus,
  fillContactDetails,
  getEvents,
  getSessionTypes,
  makeScenarioEmail,
  mutateTestBooking,
  updateAdminEvent,
  updateAdminTimingSetting,
  waitForBookingArtifacts,
} from './support/api';
import { expectInlineMockEmailPreview } from './support/mock-email-preview';
import { attachRuntimeMonitor } from './support/runtime';

type RemainingPublicFn = (args: {
  page: Page;
  testInfo: TestInfo;
  prefix: string;
}) => Promise<void>;

export interface RemainingPublicCase {
  title: string;
  fn?: RemainingPublicFn;
  fixmeReason?: string;
}

function title(prefix: string, text: string) {
  return prefix ? `${prefix} ${text}` : text;
}

async function openSessionsBookLink(page: Page, hrefFragment: string) {
  await page.goto(`${SITE_BASE_URL}/sessions.html`);
  await page.locator(`a.btn[href*="${hrefFragment}"]`).first().click();
}

async function submitReminderOnCard(page: Page, eventSlug: string, email: string) {
  const card = page.locator(`#${eventSlug}`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Join reminders list' }).click();
  await card.locator('input[type="email"]').fill(email);
  await card.locator('button[type="submit"]').click();
}

export function getRemainingPublicCases(prefix = ''): RemainingPublicCase[] {
  return [
    {
      title: title(prefix, 'T01 open sessions page shows only public offers'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const sessionTypes = await getSessionTypes();

        const checkpoint = runtime.checkpoint();
        await page.goto(`${SITE_BASE_URL}/sessions.html`);
        await expect(page.locator('#sessionGrid .event-card')).toHaveCount(sessionTypes.length);
        for (const session of sessionTypes) {
          const expectedHref = session.slug === 'intro-clarity-conversation'
            ? 'book.html?type=intro'
            : `offer=${session.slug}`;
          await expect(page.locator(`#sessionGrid a.btn[href*="${expectedHref}"]`)).toHaveCount(1);
        }
        await runtime.assertNoNewIssues(checkpoint, 'sessions-page-public-offers', testInfo);
      },
    },
    {
      title: title(prefix, 'T04 open evenings page shows upcoming and past sections clearly'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);

        const checkpoint = runtime.checkpoint();
        await page.goto(`${SITE_BASE_URL}/evenings.html`);
        await expect(page.locator('#btn-upcoming')).toBeVisible();
        await expect(page.locator('#btn-past')).toBeVisible();
        await expect(page.locator('#tab-upcoming')).toBeVisible();
        await page.locator('#btn-past').click();
        await expect(page.locator('#tab-past')).toBeVisible();
        await runtime.assertNoNewIssues(checkpoint, 'evenings-page-sections-clear', testInfo);
      },
    },
    {
      title: title(prefix, 'T05 sold out evening is not normally bookable'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const soldOutEvent = (await getEvents()).find((event) => event.render?.sold_out === true);
        if (!soldOutEvent) return;

        const checkpoint = runtime.checkpoint();
        await page.goto(`${SITE_BASE_URL}/evenings.html`);
        const soldOutCard = page.locator(`#${soldOutEvent.slug}`);
        await expect(soldOutCard).toContainText('Sold out');
        await expect(soldOutCard.getByRole('link', { name: 'Book your spot' })).toHaveCount(0);
        await expect(soldOutCard.getByRole('button', { name: 'Join reminders list' })).toHaveCount(1);
        await runtime.assertNoNewIssues(checkpoint, 'sold-out-evening-state', testInfo);
      },
    },
    {
      title: title(prefix, 'T06 closed evening is not normally bookable'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const event = (await getAdminEventsAll()).find((row) => row.status === 'published' && row.is_paid === false);
        if (!event) return;

        const original = { starts_at: event.starts_at, ends_at: event.ends_at };
        const now = Date.now();
        const closedStart = new Date(now - 40 * 60_000).toISOString();
        const closedEnd = new Date(now + 20 * 60_000).toISOString();

        await updateAdminEvent(event.id, { starts_at: closedStart, ends_at: closedEnd });
        try {
          const checkpoint = runtime.checkpoint();
          await page.goto(`${SITE_BASE_URL}/evenings.html`);
          await page.locator('#btn-past').click();
          await expect(page.locator('#tab-past')).toBeVisible();
          const closedCard = page.locator(`#${event.slug}`);
          await expect(closedCard).toBeVisible();
          await expect(closedCard.getByRole('link', { name: 'Book your spot' })).toHaveCount(0);
          await expect(closedCard.getByRole('button', { name: 'Join reminders list' })).toHaveCount(1);
          await runtime.assertNoNewIssues(checkpoint, 'closed-evening-state', testInfo);
        } finally {
          await updateAdminEvent(event.id, original);
        }
      },
    },
    {
      title: title(prefix, 'T07 reminder signup on unavailable evening succeeds without creating booking'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const unavailableEvent = (await getEvents()).find((event) => event.render?.show_reminder_signup_cta === true);
        if (!unavailableEvent) return;

        const email = makeScenarioEmail('p4-reminder');
        const checkpoint = runtime.checkpoint();
        await page.goto(`${SITE_BASE_URL}/evenings.html`);
        await submitReminderOnCard(page, unavailableEvent.slug, email);
        await expect(page.locator(`#${unavailableEvent.slug} [data-reminder-msg="${unavailableEvent.id}"]`)).toContainText('You are on the reminders list.');
        await runtime.assertNoNewIssues(checkpoint, 'reminder-signup-unavailable-evening', testInfo);
      },
    },
    {
      title: title(prefix, 'T09 contact form invalid submit shows validation and no success state'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);

        const checkpoint = runtime.checkpoint();
        await page.goto(`${SITE_BASE_URL}/contact.html`);
        await page.locator('#contact-submit-btn').click();
        await expect(page.locator('#contact-email-error')).toContainText('Please enter your email address.');
        await expect(page.locator('#contact-message-error')).toContainText('Please write a message.');
        await expect(page.locator('#contact-success')).toBeHidden();
        await runtime.assertNoNewIssues(checkpoint, 'contact-invalid-submit', testInfo);
      },
    },
    {
      title: title(prefix, 'T12 and T17 pay-later session booking stays pending until confirmation, then starts payment'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const email = makeScenarioEmail('p4-pay-later');

        await openSessionsBookLink(page, 'book.html?type=session&offer=');
        await expect(page).toHaveURL(/\/book(?:\.html)?\?type=session/);

        let checkpoint = runtime.checkpoint();
        await clickFirstAvailableSlot(page);
        await fillContactDetails(page, {
          firstName: 'P4',
          lastName: 'PayLater',
          email,
          phone: '+41790000000',
        });
        await page.locator('[data-payment="pay-later"]').click();
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.locator('button[data-submit]').click();
        await expectInlineMockEmailPreview(page, {
          title: 'Booking received',
          frameText: 'Please confirm your session booking.',
          actionName: 'Confirm booking',
          actionHref: /\/confirm\.html\?token=/,
        });
        await runtime.assertNoNewIssues(checkpoint, 'pay-later-submit', testInfo);

        const pendingArtifacts = await waitForBookingArtifacts(email);
        expect(pendingArtifacts.booking.status).toBe('PENDING');
        expect(pendingArtifacts.payment).toBeNull();
        expect(pendingArtifacts.links.confirm_url).toBeTruthy();

        checkpoint = runtime.checkpoint();
        await page.goto(pendingArtifacts.links.confirm_url!);
        await expectInlineMockEmailPreview(page, {
          title: 'Confirmed!',
          frameText: /confirmed|Manage booking|Complete payment/i,
          actionName: /Complete payment/i,
          actionHref: /\/continue-payment\.html\?token=/,
        });
        await runtime.assertNoNewIssues(checkpoint, 'pay-later-confirm', testInfo);

        const confirmedArtifacts = await waitForBookingArtifacts(email);
        expect(confirmedArtifacts.booking.status).toBe('CONFIRMED');
        expect(confirmedArtifacts.payment).toBeTruthy();
        expect(['PENDING', 'INVOICE_SENT']).toContain(confirmedArtifacts.payment?.status);
      },
    },
    {
      title: title(prefix, 'T15 late-access evening booking works'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const event = (await getAdminEventsAll()).find((row) => row.status === 'published' && row.is_paid === false);
        if (!event) return;

        const original = { starts_at: event.starts_at, ends_at: event.ends_at };
        const now = Date.now();
        const closedStart = new Date(now - 40 * 60_000).toISOString();
        const closedEnd = new Date(now + 20 * 60_000).toISOString();
        const email = makeScenarioEmail('p4-late-access-public');

        await updateAdminEvent(event.id, { starts_at: closedStart, ends_at: closedEnd });
        try {
          const lateAccess = await createLateAccessLink(event.id);
          const checkpoint = runtime.checkpoint();
          await page.goto(lateAccess.url);
          await fillContactDetails(page, {
            firstName: 'P4',
            lastName: 'LateAccess',
            email,
            phone: '+41790000000',
          });
          await page.locator('button[data-submit]').click();
          await expectInlineMockEmailPreview(page, {
            title: /Registration received|Registration confirmed|Booking received|Confirmed!/i,
            frameText: /confirm your spot|confirmed|Manage booking/i,
          });
          const artifacts = await waitForBookingArtifacts(email);
          expect(artifacts.booking.status).toBe('CONFIRMED');
          await runtime.assertNoNewIssues(checkpoint, 'late-access-evening-booking', testInfo);
        } finally {
          await updateAdminEvent(event.id, original);
        }
      },
    },
    {
      title: title(prefix, 'T19 abandoning Stripe checkout does not falsely confirm the booking'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const email = makeScenarioEmail('p4-abandon-pay');

        await openSessionsBookLink(page, 'book.html?type=session&offer=');
        await expect(page).toHaveURL(/\/book(?:\.html)?\?type=session/);

        const checkpoint = runtime.checkpoint();
        await clickFirstAvailableSlot(page);
        await fillContactDetails(page, {
          firstName: 'P4',
          lastName: 'Abandon',
          email,
          phone: '+41790000000',
        });
        await page.locator('[data-payment="pay-now"]').click();
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.locator('button[data-submit]').click();
        await page.waitForURL(/\/dev-pay\?session_id=/);
        await runtime.assertNoNewIssues(checkpoint, 'pay-now-abandon-dev-pay', testInfo);

        const artifacts = await waitForBookingArtifacts(email);
        expect(artifacts.booking.status).toBe('PENDING');
        expect(artifacts.payment?.status).toBe('PENDING');
      },
    },
    {
      title: title(prefix, 'T20 expired confirmation link shows explicit expired state'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const email = makeScenarioEmail('p4-expired-confirm');

        await openSessionsBookLink(page, 'book.html?type=intro');
        await expect(page).toHaveURL(/\/book(?:\.html)?\?type=intro/);
        await clickFirstAvailableSlot(page);
        await fillContactDetails(page, {
          firstName: 'P4',
          lastName: 'Expired',
          email,
          phone: '+41790000000',
        });
        await page.locator('button[data-submit]').click();
        await expectInlineMockEmailPreview(page, {
          title: 'Booking received',
          frameText: 'Please confirm your session booking.',
          actionName: 'Confirm booking',
          actionHref: /\/confirm\.html\?token=/,
        });

        const artifacts = await waitForBookingArtifacts(email);
        expect(artifacts.links.confirm_url).toBeTruthy();
        const expiredAt = new Date(Date.now() - 10 * 60_000).toISOString();
        await mutateTestBooking({
          email,
          latest_submission_created_at: expiredAt,
        });

        const checkpoint = runtime.checkpoint();
        await page.goto(artifacts.links.confirm_url!);
        await expect(page.locator('.confirm-title')).toContainText(/Could not confirm|Invalid|Expired|Link expired/i);
        await runtime.assertNoNewIssues(checkpoint, 'expired-confirm-link', testInfo, {
          allow: [
            {
              kind: 'http',
              urlIncludes: '/api/bookings/confirm?token=',
              messageIncludes: '-> 410',
            },
            {
              kind: 'console',
              urlIncludes: '/api/bookings/confirm?token=',
              messageIncludes: 'status of 410',
            },
            {
              kind: 'console',
              urlIncludes: '/js/client.js',
              messageIncludes: 'GET /api/bookings/confirm?token=',
            },
          ],
        });
      },
    },
    {
      title: title(prefix, 'T22 invalid manage link shows explicit load-fail state'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const checkpoint = runtime.checkpoint();
        await page.goto(`${SITE_BASE_URL}/manage.html?token=not-a-real-token`);
        await expect(page.locator('.manage-title')).toContainText(/Could Not Open Booking|Invalid Manage Link/);
        await runtime.assertNoNewIssues(checkpoint, 'invalid-manage-link', testInfo, {
          allow: [
            {
              kind: 'http',
              urlIncludes: '/api/bookings/manage?token=not-a-real-token',
              messageIncludes: '-> 400',
            },
            {
              kind: 'console',
              urlIncludes: '/api/bookings/manage?token=not-a-real-token',
              messageIncludes: 'status of 400',
            },
            {
              kind: 'console',
              urlIncludes: '/js/client.js',
              messageIncludes: 'GET /api/bookings/manage?token=not-a-real-token',
            },
          ],
        });
      },
    },
    {
      title: title(prefix, 'T25 event booking does not expose self-reschedule action'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const email = makeScenarioEmail('p4-event-manage');
        const freeEvent = (await getEvents()).find((event) => event.is_paid === false && event.render?.public_registration_open === true);
        if (!freeEvent) return;

        await page.goto(`${SITE_BASE_URL}/evenings.html`);
        await page.locator(`a.btn[href*="eventSlug=${freeEvent.slug}"]`).first().click();
        await fillContactDetails(page, {
          firstName: 'P4',
          lastName: 'EventManage',
          email,
          phone: '+41790000000',
        });
        await page.locator('button[data-submit]').click();
        await expectInlineMockEmailPreview(page, {
          title: 'Registration received',
          frameText: 'Please confirm your spot.',
          actionName: 'Confirm my spot',
          actionHref: /\/confirm\.html\?token=/,
        });
        const pendingArtifacts = await waitForBookingArtifacts(email);
        await page.goto(pendingArtifacts.links.confirm_url!);
        await expectInlineMockEmailPreview(page, {
          title: 'Confirmed!',
          frameText: /confirmed|Manage booking/i,
        });
        const confirmedArtifacts = await expectManageStatus(email, 'CONFIRMED');

        const checkpoint = runtime.checkpoint();
        await page.goto(confirmedArtifacts.links.manage_url);
        await expect(page.getByRole('link', { name: 'Reschedule' })).toHaveCount(0);
        await expect(page.locator('.manage-actions')).toContainText('Homepage');
        await runtime.assertNoNewIssues(checkpoint, 'event-manage-no-reschedule', testInfo);
      },
    },
    {
      title: title(prefix, 'T26 locked booking blocks restricted self-service actions'),
      async fn({ page, testInfo }) {
        const runtime = attachRuntimeMonitor(page);
        const email = makeScenarioEmail('p4-lock-window');

        await openSessionsBookLink(page, 'book.html?type=intro');
        await expect(page).toHaveURL(/\/book(?:\.html)?\?type=intro/);
        await clickFirstAvailableSlot(page);
        await fillContactDetails(page, {
          firstName: 'P4',
          lastName: 'Locked',
          email,
          phone: '+41790000000',
        });
        await page.locator('button[data-submit]').click();
        const pending = await waitForBookingArtifacts(email);
        await page.goto(pending.links.confirm_url!);
        await expectInlineMockEmailPreview(page, {
          title: 'Confirmed!',
          frameText: /confirmed|Manage booking|Complete payment/i,
        });

        const confirmed = await expectManageStatus(email, 'CONFIRMED');
        const originalPolicy = (await getAdminTimingSettings()).find((entry) => entry.keyname === 'selfServiceLockWindowHours');
        if (!originalPolicy) throw new Error('selfServiceLockWindowHours setting not found');

        await updateAdminTimingSetting('selfServiceLockWindowHours', '100000');
        try {
          const checkpoint = runtime.checkpoint();
          await page.goto(confirmed.links.manage_url);
          await expect(page.locator('.policy-box.policy-box--text')).toContainText(/no longer available online|less than .* hours/i);
          await expect(page.getByRole('link', { name: 'Reschedule' })).toHaveCount(0);
          await expect(page.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);
          await runtime.assertNoNewIssues(checkpoint, 'locked-manage-window', testInfo);
        } finally {
          await updateAdminTimingSetting('selfServiceLockWindowHours', originalPolicy.value);
        }
      },
    },
  ];
}
