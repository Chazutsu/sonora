import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  testMatch: 'visual.spec.ts',
  outputDir: './tests/visual/test-results',
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4179/tests/visual/',
    colorScheme: 'light',
    locale: 'ja-JP',
  },
  webServer: {
    command: 'node tests/visual/server.mjs',
    url: 'http://127.0.0.1:4179/tests/visual/',
    reuseExistingServer: false,
  },
});
