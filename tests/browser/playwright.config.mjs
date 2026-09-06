import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  outputDir: "../../test-results/browser",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  workers: 2,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  projects: [{ name: "chromium", use: { browserName: "chromium", channel: "chromium" } }],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    screenshot: "off",
    video: "off",
    trace: "off",
  },
});
