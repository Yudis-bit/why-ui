import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  outputDir: "../../test-results/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: {
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "UTC",
    screenshot: "off",
    video: "off",
    trace: "off",
  },
});
