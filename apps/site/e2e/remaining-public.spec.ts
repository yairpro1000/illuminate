import { test } from '@playwright/test';
import { ensureAntiBotMock, ensureEmailMock } from './support/api';
import { getRemainingPublicCases } from './remaining-public.shared';

test.beforeAll(async () => {
  await ensureEmailMock();
  await ensureAntiBotMock();
});

for (const publicCase of getRemainingPublicCases()) {
  if (publicCase.fixmeReason) {
    test(publicCase.title, async () => {
      test.fixme(true, publicCase.fixmeReason);
    });
    continue;
  }

  test(publicCase.title, async ({ page }, testInfo) => {
    await publicCase.fn!({ page, testInfo, prefix: '' });
  });
}
