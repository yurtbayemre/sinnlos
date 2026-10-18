import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  globalTimeout: 5 * 60_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["html", { outputFolder: "../.e2e/report", open: "never" }]],
  outputDir: "../.e2e/results",
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
