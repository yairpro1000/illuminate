import { expect, type Page, type TestInfo } from '@playwright/test';

interface RuntimeIssue {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'http';
  message: string;
  url?: string;
}

interface RuntimeCheckpoint {
  index: number;
}

function shouldIgnoreUrl(url: string): boolean {
  return (
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.includes('/favicon.ico') ||
    url.includes('/api/observability/frontend')
  );
}

function shouldTrackHttpFailure(url: string, status: number): boolean {
  if (shouldIgnoreUrl(url)) return false;
  return status >= 400;
}

function shouldIgnoreRequestFailure(url: string, errorText: string | null | undefined): boolean {
  if (shouldIgnoreUrl(url)) return true;
  return errorText === 'net::ERR_ABORTED';
}

export function attachRuntimeMonitor(page: Page) {
  const issues: RuntimeIssue[] = [];

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    issues.push({
      kind: 'console',
      message: msg.text(),
      url: msg.location().url || page.url(),
    });
  });

  page.on('pageerror', (error) => {
    issues.push({
      kind: 'pageerror',
      message: error.message,
      url: page.url(),
    });
  });

  page.on('requestfailed', (request) => {
    const url = request.url();
    const errorText = request.failure()?.errorText;
    if (shouldIgnoreRequestFailure(url, errorText)) return;
    issues.push({
      kind: 'requestfailed',
      message: `${request.method()} ${url} :: ${errorText || 'request failed'}`,
      url,
    });
  });

  page.on('response', (response) => {
    const url = response.url();
    if (!shouldTrackHttpFailure(url, response.status())) return;
    issues.push({
      kind: 'http',
      message: `${response.request().method()} ${url} -> ${response.status()}`,
      url,
    });
  });

  return {
    checkpoint(): RuntimeCheckpoint {
      return { index: issues.length };
    },
    async assertNoNewIssues(
      checkpoint: RuntimeCheckpoint,
      label: string,
      testInfo: TestInfo,
    ): Promise<void> {
      const newIssues = issues.slice(checkpoint.index);
      if (newIssues.length === 0) return;

      await testInfo.attach(`${label}-runtime-issues`, {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(newIssues, null, 2), 'utf8'),
      });

      expect(newIssues, `Unexpected runtime issues during ${label}`).toEqual([]);
    },
  };
}
