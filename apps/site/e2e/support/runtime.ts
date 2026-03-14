import { expect, type Page, type TestInfo } from '@playwright/test';

interface RuntimeIssue {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'http';
  message: string;
  url?: string;
}

interface RuntimeCheckpoint {
  index: number;
}

interface RuntimeIssueExpectation {
  kind?: RuntimeIssue['kind'];
  messageIncludes?: string;
  urlIncludes?: string;
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

  function matchesExpectation(issue: RuntimeIssue, expected: RuntimeIssueExpectation): boolean {
    if (expected.kind && issue.kind !== expected.kind) return false;
    if (expected.messageIncludes && !issue.message.includes(expected.messageIncludes)) return false;
    if (expected.urlIncludes && !(issue.url || '').includes(expected.urlIncludes)) return false;
    return true;
  }

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
      options?: { allow?: RuntimeIssueExpectation[] },
    ): Promise<void> {
      const rawIssues = issues.slice(checkpoint.index);
      const allowed = options?.allow ?? [];
      const newIssues = rawIssues.filter((issue) => !allowed.some((expected) => matchesExpectation(issue, expected)));
      if (newIssues.length === 0) return;

      await testInfo.attach(`${label}-runtime-issues`, {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({
          unexpected: newIssues,
          allowed: rawIssues.filter((issue) => !newIssues.includes(issue)),
        }, null, 2), 'utf8'),
      });

      expect(newIssues, `Unexpected runtime issues during ${label}`).toEqual([]);
    },
  };
}
