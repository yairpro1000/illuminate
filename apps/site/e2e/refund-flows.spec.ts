import { expect, test, type Page } from '@playwright/test';
import {
  SITE_BASE_URL,
  fetchCapturedEmailPreviewHtml,
  findEventArtifacts,
  findSideEffectArtifacts,
  clickFirstAvailableSlot,
  ensureAntiBotMock,
  ensurePaymentsMock,
  ensureEmailMock,
  fillContactDetails,
  getSupabaseBookingRowById,
  getSupabasePaymentRowByBookingId,
  waitForBookingArtifacts,
  waitForBookingArtifactsWhere,
  waitForCapturedEmail,
} from './support/api';
import { expectInlineMockEmailPreview } from './support/mock-email-preview';
import { attachRuntimeMonitor } from './support/runtime';
import { API_BASE_URL } from './support/api';

async function bookPaidSession(page: Page, email: string, paymentMode: 'pay-now' | 'pay-later') {
  await page.goto(`${SITE_BASE_URL}/sessions.html`);
  await page.locator('a.btn[href*="book.html?type=session&offer="]').first().click();
  await expect(page).toHaveURL(/\/book(?:\.html)?\?type=session/);

  const chosenSlot = await clickFirstAvailableSlot(page);
  await fillContactDetails(page, {
    firstName: 'E2E',
    lastName: paymentMode === 'pay-now' ? 'RefundPayNow' : 'RefundPayLater',
    email,
    phone: '+41790000000',
  });
  await page.locator(`[data-payment="${paymentMode}"]`).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.step-eyebrow')).toContainText('Review your booking');
  await expect(page.locator('.review-table')).toContainText(chosenSlot.timeLabel);
  await page.locator('button[data-submit]').click();
}

async function settleCheckout(page: Page) {
  await Promise.race([
    page.waitForURL(/\/dev-pay(\.html)?\?session_id=/, { timeout: 30_000 }),
    page.waitForURL(/checkout\.stripe\.com\/c\/pay\//, { timeout: 30_000 }),
  ]);

  if (/\/dev-pay(\.html)?\?session_id=/.test(page.url())) {
    const legacyButton = page.locator('#btn-success');
    if (await legacyButton.count()) {
      await legacyButton.click();
    } else {
      await page.getByRole('button', { name: /simulate payment success/i }).first().click();
    }
  } else {
    if (!/\/payment-success(\.html)?\?session_id=/.test(page.url())) {
      await settleStripeCheckout(page);
    }
  }
  await Promise.race([
    page.waitForURL(/\/payment-success(\.html)?\?session_id=/, { timeout: 15_000 }),
    page.waitForTimeout(3_000),
  ]);
}

async function settleStripeCheckout(page: Page) {
  const payWithCardButton = page.getByRole('button', { name: /Pay with card/i });
  if (await payWithCardButton.count() && await payWithCardButton.first().isVisible()) {
    await payWithCardButton.first().click();
  }

  const cardFrame = await findStripeCardFrame(page, 20_000);
  await cardFrame.fill('input[name="cardnumber"]', '4242424242424242');
  await cardFrame.fill('input[name="exp-date"]', '12/34');
  await cardFrame.fill('input[name="cvc"]', '123');

  const billingName = page.locator('input[name="billingName"]').first();
  if (await billingName.count()) {
    await billingName.fill('E2E Refund');
  }

  const payButton = page.locator('button:visible').filter({ hasText: /^Pay$/ }).first();
  await payButton.click();
}

async function findStripeCardFrame(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('Stripe checkout page closed before card form was filled');
    if (!/checkout\.stripe\.com/.test(page.url())) {
      throw new Error(`Expected Stripe checkout URL while resolving card frame, got: ${page.url()}`);
    }
    for (const frame of page.frames()) {
      try {
        const cardInput = frame.locator('input[name="cardnumber"]');
        if (await cardInput.count()) {
          await cardInput.first().waitFor({ state: 'visible', timeout: 2_000 });
          return frame;
        }
      } catch {
        // Stripe frequently detaches/reattaches nested frames during initialization.
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Could not locate Stripe card input frame');
}

async function confirmPayLaterBooking(page: Page, email: string) {
  const pendingArtifacts = await waitForBookingArtifacts(email);
  expect(pendingArtifacts.links.confirm_url).toBeTruthy();

  await page.goto(normalizeSiteUrl(pendingArtifacts.links.confirm_url!));
  const preview = await expectInlineMockEmailPreview(page, {
    title: 'Confirmed!',
    frameText: /confirmed|Manage booking|Complete payment/i,
    actionName: /Complete payment/i,
    actionHref: /\/continue-payment\.html\?token=/,
  });
  expect(preview.actionHref).toBeTruthy();

  const confirmedArtifacts = await waitForBookingArtifactsWhere(email, (artifacts) =>
    artifacts.booking.status === 'CONFIRMED'
    && Boolean(artifacts.payment)
    && ['PENDING', 'INVOICE_SENT'].includes(artifacts.payment?.status || ''),
  );
  return {
    pendingArtifacts,
    confirmedArtifacts,
    continuePaymentUrl: preview.actionHref!,
  };
}

async function cancelFromManage(page: Page, manageUrl: string) {
  const url = normalizeSiteUrl(manageUrl);
  await page.goto(url, { waitUntil: 'commit' });

  const cancelButton = page.locator('#cancel-btn').or(page.getByRole('button', { name: /Cancel booking/i })).first();
  await expect(cancelButton).toBeVisible();
  await cancelButton.click();

  const legacyConfirm = page.locator('#cancel-yes');
  if (await legacyConfirm.count() && await legacyConfirm.first().isVisible()) {
    await legacyConfirm.first().click();
  } else {
    await page.getByRole('button', { name: /Yes, cancel booking/i }).first().click();
  }
}

function normalizeSiteUrl(rawUrl: string): string {
  const target = new URL(rawUrl, SITE_BASE_URL);
  const site = new URL(SITE_BASE_URL);
  target.protocol = site.protocol;
  target.host = site.host;
  return target.toString();
}

async function waitForRefundedArtifacts(email: string) {
  return waitForBookingArtifactsWhere(email, (artifacts) =>
    artifacts.booking.status === 'CANCELED'
    && artifacts.payment?.status === 'REFUNDED'
    && artifacts.payment?.refund_status === 'SUCCEEDED'
    && Boolean(artifacts.payment?.credit_note_url)
    && Boolean(artifacts.payment?.receipt_url)
    && Boolean(findEventArtifacts(artifacts, 'REFUND_COMPLETED')),
  );
}

async function assertRefundUi(
  page: Page,
  manageUrl: string,
  refundedArtifacts: Awaited<ReturnType<typeof waitForRefundedArtifacts>>,
) {
  const expectedCreditNote = refundedArtifacts.payment?.credit_note_url || '';
  const expectedReceipt = refundedArtifacts.payment?.receipt_url || '';
  const expectedInvoice = refundedArtifacts.payment?.invoice_url || '';
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    await page.goto(normalizeSiteUrl(manageUrl), { waitUntil: 'domcontentloaded' });
    const creditNoteLink = page.getByRole('link', { name: 'View credit note' });
    const receiptLink = page.getByRole('link', { name: 'View receipt' });
    const invoiceLink = page.getByRole('link', { name: 'View invoice' });

    const creditHref = await creditNoteLink.first().getAttribute('href').catch(() => null);
    const receiptHref = await receiptLink.first().getAttribute('href').catch(() => null);
    const invoiceHref = await invoiceLink.first().getAttribute('href').catch(() => null);

    if (creditHref === expectedCreditNote && receiptHref === expectedReceipt && invoiceHref === expectedInvoice) {
      return;
    }
    await page.waitForTimeout(500);
  }

  throw new Error('Manage UI did not reflect refunded state within 20s');
}

async function assertRefundEmails(email: string) {
  const cancellationEmail = await waitForCapturedEmail(email, 'booking_cancellation');
  const refundEmail = await waitForCapturedEmail(email, 'refund_confirmation');

  expect(cancellationEmail.subject).toMatch(/has been cancelled/i);
  expect(refundEmail.subject).toMatch(/Your refund for/i);

  const cancellationHtml = await fetchCapturedEmailPreviewHtml(cancellationEmail.preview_html_url);
  const refundHtml = await fetchCapturedEmailPreviewHtml(refundEmail.preview_html_url);

  expect(cancellationHtml).toContain('separate confirmation email');
  expect(refundHtml).toContain('Your refund has been processed');
  expect(refundHtml).toContain('View receipt');
  expect(refundHtml).toContain('View credit note');
}

async function assertRefundDatabaseState(refundedArtifacts: Awaited<ReturnType<typeof waitForRefundedArtifacts>>) {
  expect(refundedArtifacts.client.id).toBeTruthy();
  expect(refundedArtifacts.booking.id).toBeTruthy();
  expect(refundedArtifacts.payment?.id).toBeTruthy();
  expect(refundedArtifacts.payment?.refund_status).toBe('SUCCEEDED');
  expect(refundedArtifacts.payment?.refunded_at).toBeTruthy();
  expect(refundedArtifacts.payment?.stripe_invoice_id).toBeTruthy();
  expect(refundedArtifacts.payment?.stripe_refund_id).toBeTruthy();
  expect(refundedArtifacts.payment?.stripe_credit_note_id).toBeTruthy();
  expect(refundedArtifacts.payment?.invoice_url).toBeTruthy();
  expect(refundedArtifacts.payment?.receipt_url).toBeTruthy();
  expect(refundedArtifacts.payment?.credit_note_url).toBeTruthy();

  const canceledEvent = findEventArtifacts(refundedArtifacts, 'BOOKING_CANCELED');
  const refundCompletedEvent = findEventArtifacts(refundedArtifacts, 'REFUND_COMPLETED');
  expect(canceledEvent).toBeTruthy();
  expect(refundCompletedEvent).toBeTruthy();

  const cancellationEmailEffect = findSideEffectArtifacts(refundedArtifacts, 'BOOKING_CANCELED', 'SEND_BOOKING_CANCELLATION_CONFIRMATION');
  const refundCreationEffect = findSideEffectArtifacts(refundedArtifacts, 'BOOKING_CANCELED', 'CREATE_STRIPE_REFUND');
  const refundEmailEffect = findSideEffectArtifacts(refundedArtifacts, 'REFUND_COMPLETED', 'SEND_BOOKING_REFUND_CONFIRMATION');
  expect(cancellationEmailEffect?.status).toBe('SUCCESS');
  expect(refundCreationEffect?.status).toBe('SUCCESS');
  expect(refundEmailEffect?.status).toBe('SUCCESS');
  expect(cancellationEmailEffect?.attempts.length).toBeGreaterThan(0);
  expect(refundCreationEffect?.attempts.length).toBeGreaterThan(0);
  expect(refundEmailEffect?.attempts.length).toBeGreaterThan(0);

  const bookingRow = await getSupabaseBookingRowById(refundedArtifacts.booking.id);
  const paymentRow = await getSupabasePaymentRowByBookingId(refundedArtifacts.booking.id);
  expect(bookingRow?.id).toBe(refundedArtifacts.booking.id);
  expect(paymentRow?.status).toBe('REFUNDED');
  expect(paymentRow?.invoice_url).toBe(refundedArtifacts.payment?.invoice_url);
  expect(paymentRow?.stripe_invoice_id).toBe(refundedArtifacts.payment?.stripe_invoice_id);
}

test.describe('refund flows', () => {
  test.beforeAll(async () => {
    await ensureEmailMock();
    await ensureAntiBotMock();
    await ensurePaymentsMock();
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((apiBase) => {
      window.localStorage.setItem('API_BASE', apiBase);
    }, API_BASE_URL);
  });

  test('booking pay now + cancellation verifies refund across ui email and db', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = `refund-pay-now-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

    let checkpoint = runtime.checkpoint();
    await bookPaidSession(page, email, 'pay-now');
    await settleCheckout(page);
    await runtime.assertNoNewIssues(checkpoint, 'refund-pay-now-settle', testInfo);

    const settledArtifacts = await waitForBookingArtifactsWhere(email, (artifacts) =>
      artifacts.booking.status === 'CONFIRMED'
      && artifacts.payment?.status === 'SUCCEEDED'
      && Boolean(artifacts.payment?.receipt_url),
    );

    checkpoint = runtime.checkpoint();
    const managePage = await page.context().newPage();
    await cancelFromManage(managePage, settledArtifacts.links.manage_url);
    const refundedArtifacts = await waitForRefundedArtifacts(email);
    await assertRefundUi(managePage, settledArtifacts.links.manage_url, refundedArtifacts);
    await managePage.close();
    await runtime.assertNoNewIssues(checkpoint, 'refund-pay-now-cancel', testInfo);

    await assertRefundEmails(email);
    await assertRefundDatabaseState(refundedArtifacts);
  });

  test('booking pay later + confirm + cancel verifies refund across ui email and db', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = `refund-pay-later-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

    let checkpoint = runtime.checkpoint();
    await bookPaidSession(page, email, 'pay-later');
    await expectInlineMockEmailPreview(page, {
      title: 'Booking received',
      frameText: 'Please confirm your session booking.',
      actionName: 'Confirm booking',
      actionHref: /\/confirm\.html\?token=/,
    });
    await runtime.assertNoNewIssues(checkpoint, 'refund-pay-later-submit', testInfo);

    checkpoint = runtime.checkpoint();
    const confirmed = await confirmPayLaterBooking(page, email);
    await page.goto(normalizeSiteUrl(confirmed.continuePaymentUrl));
    await settleCheckout(page);
    await runtime.assertNoNewIssues(checkpoint, 'refund-pay-later-confirm-and-settle', testInfo);

    const settledArtifacts = await waitForBookingArtifactsWhere(email, (artifacts) =>
      artifacts.booking.status === 'CONFIRMED'
      && artifacts.payment?.status === 'SUCCEEDED'
      && Boolean(artifacts.payment?.receipt_url),
    );

    checkpoint = runtime.checkpoint();
    const managePage = await page.context().newPage();
    await cancelFromManage(managePage, settledArtifacts.links.manage_url);
    const refundedArtifacts = await waitForRefundedArtifacts(email);
    await assertRefundUi(managePage, settledArtifacts.links.manage_url, refundedArtifacts);
    await managePage.close();
    await runtime.assertNoNewIssues(checkpoint, 'refund-pay-later-cancel', testInfo);

    await assertRefundEmails(email);
    await assertRefundDatabaseState(refundedArtifacts);
  });
});
