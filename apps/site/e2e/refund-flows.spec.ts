import { expect, test, type Page } from '@playwright/test';
import {
  SITE_BASE_URL,
  fetchCapturedEmailPreviewHtml,
  findEventArtifacts,
  findSideEffectArtifacts,
  clickFirstAvailableSlot,
  ensureAntiBotMock,
  ensureEmailMock,
  ensurePaymentsMock,
  fillContactDetails,
  getSupabaseBookingRowById,
  getSupabasePaymentRowByBookingId,
  waitForBookingArtifacts,
  waitForBookingArtifactsWhere,
  waitForCapturedEmail,
} from './support/api';
import { expectInlineMockEmailPreview } from './support/mock-email-preview';
import { attachRuntimeMonitor } from './support/runtime';

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

async function settleMockCheckout(page: Page) {
  await page.waitForURL(/\/dev-pay\?session_id=/);
  await page.locator('#btn-success').click();
  await page.waitForURL(/\/payment-success(\.html)?\?session_id=/);
  await expect(page.locator('.result-title')).toContainText(/Payment confirmed!|Payment received/);
}

async function confirmPayLaterBooking(page: Page, email: string) {
  const pendingArtifacts = await waitForBookingArtifacts(email);
  expect(pendingArtifacts.links.confirm_url).toBeTruthy();

  await page.goto(pendingArtifacts.links.confirm_url!);
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
  await page.goto(manageUrl);
  await expect(page.locator('#cancel-btn')).toBeVisible();
  await page.locator('#cancel-btn').click();
  await page.locator('#cancel-yes').click();
  await expect(page.locator('.manage-title')).toContainText('Cancelled');
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

async function assertRefundUi(page: Page, refundedArtifacts: Awaited<ReturnType<typeof waitForRefundedArtifacts>>) {
  await expect(page.locator('.manage-subtitle')).toContainText(/refund processed/i);
  const creditNoteLink = page.getByRole('link', { name: 'View credit note' });
  const receiptLink = page.getByRole('link', { name: 'View receipt' });
  const invoiceLink = page.getByRole('link', { name: 'View invoice' });
  await expect(creditNoteLink).toHaveAttribute('href', refundedArtifacts.payment?.credit_note_url || '');
  await expect(receiptLink).toHaveAttribute('href', refundedArtifacts.payment?.receipt_url || '');
  await expect(invoiceLink).toHaveAttribute('href', refundedArtifacts.payment?.invoice_url || '');
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

  test('booking pay now + cancellation verifies refund across ui email and db', async ({ page }, testInfo) => {
    const runtime = attachRuntimeMonitor(page);
    const email = `refund-pay-now-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

    let checkpoint = runtime.checkpoint();
    await bookPaidSession(page, email, 'pay-now');
    await settleMockCheckout(page);
    await runtime.assertNoNewIssues(checkpoint, 'refund-pay-now-settle', testInfo);

    const settledArtifacts = await waitForBookingArtifactsWhere(email, (artifacts) =>
      artifacts.booking.status === 'CONFIRMED'
      && artifacts.payment?.status === 'SUCCEEDED'
      && Boolean(artifacts.payment?.receipt_url),
    );

    checkpoint = runtime.checkpoint();
    await cancelFromManage(page, settledArtifacts.links.manage_url);
    const refundedArtifacts = await waitForRefundedArtifacts(email);
    await assertRefundUi(page, refundedArtifacts);
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
    await page.goto(confirmed.continuePaymentUrl);
    await settleMockCheckout(page);
    await runtime.assertNoNewIssues(checkpoint, 'refund-pay-later-confirm-and-settle', testInfo);

    const settledArtifacts = await waitForBookingArtifactsWhere(email, (artifacts) =>
      artifacts.booking.status === 'CONFIRMED'
      && artifacts.payment?.status === 'SUCCEEDED'
      && Boolean(artifacts.payment?.receipt_url),
    );

    checkpoint = runtime.checkpoint();
    await cancelFromManage(page, settledArtifacts.links.manage_url);
    const refundedArtifacts = await waitForRefundedArtifacts(email);
    await assertRefundUi(page, refundedArtifacts);
    await runtime.assertNoNewIssues(checkpoint, 'refund-pay-later-cancel', testInfo);

    await assertRefundEmails(email);
    await assertRefundDatabaseState(refundedArtifacts);
  });
});
