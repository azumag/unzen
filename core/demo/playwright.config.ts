/**
 * Playwright E2E config for the unzen core demo (issue #104).
 *
 * Starts the demo server (tsx server.ts on :3000) and runs the browser-level
 * acceptance stories in e2e/. Deterministic failure injection is done in the
 * specs via page.route() on /worker.js — no production code changes needed.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop-firefox',
      use: {
        browserName: 'firefox',
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3000/unzen/manifest',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
