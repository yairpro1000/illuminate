import { expect, test, type Page, type Route } from '@playwright/test';
import { SITE_BASE_URL, clickFirstAvailableSlot, fillContactDetails, makeScenarioEmail } from './support/api';
import { expectInlineMockEmailPreview } from './support/mock-email-preview';
import { attachRuntimeMonitor } from './support/runtime';

function buildTurnstileConfigResponse() {
  return {
    config_version: 'e2e_turnstile_v1',
    visitor: { country: 'CH' },
    booking_policy: {
      non_paid_confirmation_window_minutes: 15,
      pay_now_checkout_window_minutes: 15,
      pay_now_reminder_grace_minutes: 15,
      pay_now_total_expiry_minutes: 30,
    },
    booking_policy_text: 'Booking policy\nRule 1\nRule 2\nRule 3',
    antibot: {
      mode: 'turnstile',
      turnstile: {
        enabled: true,
        site_key: '1x00000000000000000000AA',
        test_site_keys: {
          pass: '1x00000000000000000000AA',
          fail: '2x00000000000000000000AB',
        },
        env: {
          ANTIBOT_MODE: 'turnstile',
          TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
          TURNSTILE_TEST_SITE_KEY_PASS: '1x00000000000000000000AA',
          TURNSTILE_TEST_SITE_KEY_ALWAYS_FAIL: '2x00000000000000000000AB',
          TURNSTILE_SECRET_KEY_present: true,
          TURNSTILE_TEST_SECRET_KEY_PASS_present: true,
          TURNSTILE_TEST_SECRET_KEY_ALWAYS_FAIL_present: true,
        },
      },
    },
  };
}

async function installFakeTurnstile(page: Page) {
  await page.addInitScript(() => {
    const state = {
      nextToken: 'valid-turnstile-token',
      failuresRemaining: 0,
      renderCount: 0,
    };

    (window as typeof window & { __turnstileTestState: typeof state }).__turnstileTestState = state;
    (window as typeof window & { turnstile: Record<string, unknown> }).turnstile = {
      render(_container: Element, options: Record<string, (...args: unknown[]) => void>) {
        state.renderCount += 1;
        const widgetId = `widget-${state.renderCount}`;
        window.setTimeout(() => {
          if (state.failuresRemaining > 0) {
            state.failuresRemaining -= 1;
            options['error-callback']?.('forced-test-failure');
            return;
          }
          options.callback?.(state.nextToken);
        }, 0);
        return widgetId;
      },
      execute() {},
      remove() {},
    };
  });
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockTurnstileConfig(page: Page) {
  await page.route(/\/api\/config$/, async (route) => {
    await fulfillJson(route, buildTurnstileConfigResponse());
  });
}

async function mockBookingFormBootstrap(page: Page) {
  await page.route(/\/api\/session-types$/, async (route) => {
    await fulfillJson(route, {
      session_types: [
        {
          id: 'st_e2e_session',
          slug: 'e2e-paid-session',
          title: 'E2E Paid Session',
          price: 180,
          currency: 'CHF',
          duration_minutes: 60,
        },
      ],
    });
  });

  await page.route(/\/api\/slots\?/, async (route) => {
    await fulfillJson(route, {
      slots: [
        {
          type: 'session',
          start: '2026-05-06T09:00:00.000Z',
          end: '2026-05-06T10:00:00.000Z',
        },
      ],
    });
  });
}

async function mockEmailPreviewHtml(page: Page, emailId: string, html: string) {
  const emailPath = new RegExp(`/api/__dev/emails/${emailId}/html$`);
  await page.route(emailPath, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html,
    });
  });
}

test.describe('P0 turnstile UI integration', () => {
  test('booking form handles turnstile verification failure and succeeds on retry', async ({ page }, testInfo) => {
    const emailId = 'mock_turnstile_booking_email';
    await installFakeTurnstile(page);
    await mockTurnstileConfig(page);
    await mockBookingFormBootstrap(page);
    await mockEmailPreviewHtml(
      page,
      emailId,
      `
        <html>
          <body>
            <h1>Please confirm your session booking.</h1>
            <a href="${SITE_BASE_URL}/confirm.html?token=mock-turnstile-booking">Confirm booking</a>
          </body>
        </html>
      `,
    );

    await page.route(/\/api\/bookings\/pay-later$/, async (route) => {
      const payload = JSON.parse(route.request().postData() || '{}') as { turnstile_token?: string };
      if (payload.turnstile_token === 'invalid-turnstile-token') {
        await fulfillJson(route, {
          error: 'TURNSTILE_TOKEN_INVALID',
          message: 'Turnstile verification failed',
        }, 400);
        return;
      }

      expect(payload.turnstile_token).toBe('valid-turnstile-token');
      await fulfillJson(route, {
        booking_id: 'bk_turnstile_booking',
        status: 'PENDING',
        manage_url: `${SITE_BASE_URL}/manage.html?token=m1.bk_turnstile_booking`,
        continue_payment_url: `${SITE_BASE_URL}/continue-payment.html?token=m1.bk_turnstile_booking`,
        mock_email_preview: {
          email_id: emailId,
          to: 'turnstile@example.test',
          subject: 'Please confirm your booking - ILLUMINATE',
          html_url: `${SITE_BASE_URL}/api/__dev/emails/${emailId}/html`,
          email_kind: 'booking_confirm_request',
        },
      });
    });

    const runtime = attachRuntimeMonitor(page);
    await page.goto(`${SITE_BASE_URL}/book.html?type=session&offer=e2e-paid-session`);
    await expect(page).toHaveURL(/\/book(?:\.html)?\?type=session/);

    await clickFirstAvailableSlot(page);
    await fillContactDetails(page, {
      firstName: 'P0',
      lastName: 'Turnstile',
      email: makeScenarioEmail('p0-turnstile-booking'),
      phone: '+41790000000',
    });
    await page.locator('[data-payment="pay-later"]').click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.evaluate(() => {
      (window as typeof window & { __turnstileTestState: { nextToken: string } }).__turnstileTestState.nextToken = 'invalid-turnstile-token';
    });

    let checkpoint = runtime.checkpoint();
    await page.locator('button[data-submit]').click();
    await expect(page.locator('.form-error').first()).toContainText('Turnstile verification failed');
    await runtime.assertNoNewIssues(checkpoint, 'booking-turnstile-invalid-token', testInfo, {
      allow: [
        {
          kind: 'http',
          urlIncludes: '/api/bookings/pay-later',
          messageIncludes: '-> 400',
        },
        {
          kind: 'console',
          urlIncludes: '/js/client.js',
          messageIncludes: 'request_failure',
        },
        {
          kind: 'console',
          urlIncludes: '/js/book.js',
          messageIncludes: 'Submission error',
        },
      ],
    });

    await page.evaluate(() => {
      (window as typeof window & { __turnstileTestState: { nextToken: string } }).__turnstileTestState.nextToken = 'valid-turnstile-token';
    });

    checkpoint = runtime.checkpoint();
    await page.locator('button[data-submit]').click();
    await expectInlineMockEmailPreview(page, {
      title: 'Booking received',
      frameText: 'Please confirm your session booking.',
      actionName: 'Confirm booking',
      actionHref: /\/confirm\.html\?token=/,
    });
    await runtime.assertNoNewIssues(checkpoint, 'booking-turnstile-retry-success', testInfo);
  });

  test('contact form submits successfully with turnstile enabled', async ({ page }, testInfo) => {
    const emailId = 'mock_turnstile_contact_email';
    await installFakeTurnstile(page);
    await mockTurnstileConfig(page);
    await mockEmailPreviewHtml(
      page,
      emailId,
      `
        <html>
          <body>
            <h1>Turnstile-protected contact form submission.</h1>
            <p>Thanks for your message.</p>
          </body>
        </html>
      `,
    );

    await page.route(/\/api\/contact$/, async (route) => {
      const payload = JSON.parse(route.request().postData() || '{}') as { turnstile_token?: string };
      expect(payload.turnstile_token).toBe('valid-turnstile-token');
      await fulfillJson(route, {
        ok: true,
        mock_email_preview: {
          email_id: emailId,
          to: 'turnstile@example.test',
          subject: 'Message sent - ILLUMINATE',
          html_url: `${SITE_BASE_URL}/api/__dev/emails/${emailId}/html`,
          email_kind: 'contact_message',
        },
      });
    });

    const runtime = attachRuntimeMonitor(page);
    await page.goto(`${SITE_BASE_URL}/contact.html`);
    await page.fill('[name="first_name"]', 'P0');
    await page.fill('[name="email"]', makeScenarioEmail('p0-turnstile-contact'));
    await page.fill('[name="message"]', 'Turnstile-protected contact form submission.');

    const checkpoint = runtime.checkpoint();
    await page.click('#contact-submit-btn');
    await expectInlineMockEmailPreview(page, {
      title: 'Message sent',
      frameText: 'Turnstile-protected contact form submission.',
    });
    await runtime.assertNoNewIssues(checkpoint, 'contact-turnstile-submit-success', testInfo);
  });

  test('turnstile helper stays scoped to intended form pages', async ({ page }) => {
    await page.goto(`${SITE_BASE_URL}/`);
    await expect.poll(async () => {
      return await page.evaluate(() => typeof (window as typeof window & { SiteTurnstile?: unknown }).SiteTurnstile);
    }).toBe('undefined');

    await installFakeTurnstile(page);
    await mockTurnstileConfig(page);
    await mockBookingFormBootstrap(page);
    await page.goto(`${SITE_BASE_URL}/contact.html`);
    await expect.poll(async () => {
      return await page.evaluate(() => typeof (window as typeof window & { SiteTurnstile?: { resolveToken?: unknown } }).SiteTurnstile?.resolveToken);
    }).toBe('function');

    await page.goto(`${SITE_BASE_URL}/book.html?type=session&offer=e2e-paid-session`);
    await expect.poll(async () => {
      return await page.evaluate(() => typeof (window as typeof window & { SiteTurnstile?: { resolveToken?: unknown } }).SiteTurnstile?.resolveToken);
    }).toBe('function');
  });
});
