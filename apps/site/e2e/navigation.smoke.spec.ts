import { expect, test } from '@playwright/test';
import { ADMIN_BASE_URL, SITE_BASE_URL } from './support/api';
import { attachRuntimeMonitor } from './support/runtime';

function expectPath(pageUrl: string, pattern: RegExp) {
  const { pathname } = new URL(pageUrl);
  expect(pathname).toMatch(pattern);
}

async function waitForEventsPageReady(page: Parameters<typeof attachRuntimeMonitor>[0]) {
  await expect(page.locator('#events-grid')).toBeVisible();
  await expect(page.locator('#events-grid .event-card, #events-grid .events-empty, #events-grid .events-error').first()).toBeVisible();
}

async function waitForSessionsPageReady(page: Parameters<typeof attachRuntimeMonitor>[0]) {
  await expect(page.locator('#sessionGrid')).toBeVisible();
  await expect(page.locator('#sessionGrid .event-card, #sessionGrid .sessions-intro').first()).toBeVisible();
}

async function waitForAdminStatusReady(page: Parameters<typeof attachRuntimeMonitor>[0], expectedText: RegExp) {
  await page.waitForFunction((matcherSource) => {
    const status = document.querySelector('#status');
    const text = status && status.textContent ? status.textContent.trim() : '';
    if (!text || /^loading/i.test(text)) return false;
    return new RegExp(matcherSource, 'i').test(text);
  }, expectedText.source);
}

test.describe('P4 navigation smoke', () => {
  test('site desktop nav and footer are runtime-clean', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);

    await page.goto(`${SITE_BASE_URL}/`);
    await expect(page).toHaveTitle(/ILLUMINATE/i);

    let checkpoint = runtime.checkpoint();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'How We Work' }).click();
    await expect(page.locator('#how-we-work')).toBeInViewport();
    await runtime.assertNoNewIssues(checkpoint, 'site-nav-how-we-work', testInfo);

    checkpoint = runtime.checkpoint();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'About' }).click();
    await expect(page.locator('#about')).toBeInViewport();
    await runtime.assertNoNewIssues(checkpoint, 'site-nav-about', testInfo);

    checkpoint = runtime.checkpoint();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Evenings' }).click();
    expectPath(page.url(), /\/evenings(?:\.html)?$/);
    await waitForEventsPageReady(page);
    await runtime.assertNoNewIssues(checkpoint, 'site-nav-evenings', testInfo);

    checkpoint = runtime.checkpoint();
    await page.getByRole('link', { name: 'Book a Session' }).click();
    expectPath(page.url(), /\/sessions(?:\.html)?$/);
    await waitForSessionsPageReady(page);
    await runtime.assertNoNewIssues(checkpoint, 'site-nav-book-session', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/`);
    await page.getByRole('navigation', { name: 'Footer navigation' }).getByRole('link', { name: 'Evenings' }).click();
    expectPath(page.url(), /\/evenings(?:\.html)?$/);
    await waitForEventsPageReady(page);
    await runtime.assertNoNewIssues(checkpoint, 'site-footer-evenings', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/`);
    await page.getByRole('navigation', { name: 'Footer navigation' }).getByRole('link', { name: '1:1 Sessions' }).click();
    expectPath(page.url(), /\/sessions(?:\.html)?$/);
    await waitForSessionsPageReady(page);
    await runtime.assertNoNewIssues(checkpoint, 'site-footer-sessions', testInfo);

    checkpoint = runtime.checkpoint();
    await page.goto(`${SITE_BASE_URL}/worldview.html`);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'My Worldview' }).click();
    expectPath(page.url(), /\/worldview(?:\.html)?$/);
    await runtime.assertNoNewIssues(checkpoint, 'worldview-nav-self', testInfo);
  });

  test('@mobile site hamburger navigation is runtime-clean', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);

    await page.goto(`${SITE_BASE_URL}/`);
    await page.getByRole('button', { name: 'Open menu' }).click();

    let checkpoint = runtime.checkpoint();
    await page.getByRole('menuitem', { name: 'Evenings' }).click();
    expectPath(page.url(), /\/evenings(?:\.html)?$/);
    await waitForEventsPageReady(page);
    await runtime.assertNoNewIssues(checkpoint, 'mobile-menu-evenings', testInfo);

    checkpoint = runtime.checkpoint();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('menuitem', { name: 'Get in touch' }).click();
    expectPath(page.url(), /\/contact(?:\.html)?$/);
    await runtime.assertNoNewIssues(checkpoint, 'mobile-menu-contact', testInfo);
  });

  test('admin sidebar pages are runtime-clean', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);

    await page.goto(`${ADMIN_BASE_URL}/index.html`);
    expectPath(page.url(), /\/(?:index\.html)?$/);

    const pages = [
      { label: 'Bookings', pattern: /\/(?:index\.html)?$/ },
      { label: 'Edit Offers', pattern: /\/session-types(?:\.html)?$/ },
      { label: 'Contact Messages', pattern: /\/contact-messages(?:\.html)?$/ },
      { label: 'Config', pattern: /\/config(?:\.html)?$/ },
    ];

    for (const item of pages) {
      const checkpoint = runtime.checkpoint();
      await page.locator(`.admin-nav-link:has-text("${item.label}")`).click();
      expectPath(page.url(), item.pattern);
      if (item.label === 'Bookings') {
        await waitForAdminStatusReady(page, /ready|loaded .* bookings|no rows/i);
      } else if (item.label === 'Edit Offers') {
        await waitForAdminStatusReady(page, /ready/i);
      } else if (item.label === 'Contact Messages') {
        await waitForAdminStatusReady(page, /loaded .* messages|no messages/i);
      } else if (item.label === 'Config') {
        await waitForAdminStatusReady(page, /ready/i);
      }
      await runtime.assertNoNewIssues(checkpoint, `admin-nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`, testInfo);
    }
  });
});
