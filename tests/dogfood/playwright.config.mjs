import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: '*.spec.mjs', timeout: 240_000,
  expect: { timeout: 15_000 }, workers: 1, retries: 0, forbidOnly: Boolean(process.env.CI),
  outputDir: '../../test-results/dogfood', reporter: [['list']],
  use: { screenshot: 'off', video: 'off', trace: 'off' } });
