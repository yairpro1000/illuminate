import { expect, type Locator, type Page } from '@playwright/test';

interface InlinePreviewOptions {
  title?: string | RegExp;
  frameText?: string | RegExp;
  actionName?: string | RegExp;
  actionHref?: RegExp;
}

export async function expectInlineMockEmailPreview(
  page: Page,
  options: InlinePreviewOptions = {},
): Promise<{ frameBody: Locator; actionHref: string | null }> {
  const frameElement = page.locator('iframe.mock-email-preview__frame').first();
  await expect(frameElement).toBeVisible();

  if (options.title) {
    await expect(page.locator('.mock-email-preview__title').first()).toContainText(options.title);
  }

  const frame = page.frameLocator('iframe.mock-email-preview__frame').first();
  const frameBody = frame.locator('body');
  await expect(frameBody).toBeVisible();

  if (options.frameText) {
    await expect(frameBody).toContainText(options.frameText);
  }

  let actionHref: string | null = null;
  if (options.actionName) {
    const action = frame.getByRole('link', { name: options.actionName });
    await expect(action).toBeVisible();
    actionHref = await action.getAttribute('href');
    if (options.actionHref) {
      expect(actionHref).toMatch(options.actionHref);
    }
  }

  return { frameBody, actionHref };
}

export async function expectNoInlineMockEmailPreview(page: Page): Promise<void> {
  await expect(page.locator('iframe.mock-email-preview__frame')).toHaveCount(0);
}
