import baseConfig from './playwright.config';

export default {
  ...baseConfig,
  use: {
    ...baseConfig.use,
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
  outputDir: './test-results/mobile-capture',
};
