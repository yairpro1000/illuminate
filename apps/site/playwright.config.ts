import { defineConfig, devices } from '@playwright/test';

const siteBaseUrl = process.env.E2E_SITE_BASE_URL || 'https://letsilluminate.co';
const adminBaseUrl = process.env.E2E_ADMIN_BASE_URL || 'https://admin.letsilluminate.co';
const apiBaseUrl = process.env.E2E_API_BASE_URL || 'https://api.letsilluminate.co';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: './playwright-report', open: 'never' }],
  ],
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    baseURL: siteBaseUrl,
    ignoreHTTPSErrors: false,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  outputDir: './test-results',
  projects: [
    {
      name: 'desktop',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 1100 },
      },
      grepInvert: /@mobile/,
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
      },
      grep: /@mobile/,
    },
  ],
  metadata: {
    siteBaseUrl,
    adminBaseUrl,
    apiBaseUrl,
  },
});
