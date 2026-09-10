import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  outputDir: "test-results",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: process.env.QV_BASE_URL ?? "http://localhost:50188",
    viewport: { width: 1600, height: 1200 },
    launchOptions: {
      executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    },
    screenshot: "only-on-failure",
    video: "off",
  },
});
