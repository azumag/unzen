/**
 * Playwright E2E config for the unzen core demo (issue #104).
 *
 * Starts the demo server and runs the browser-level acceptance stories in
 * e2e/. Set UNZEN_DEMO_PORT when :3000 is occupied. Deterministic failure
 * injection is done via page.route() on /worker.js.
 */
import { defineConfig } from '@playwright/test';

const port = process.env.UNZEN_DEMO_PORT ?? '3000';
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
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
    url: `${baseURL}/unzen/manifest`,
    env: { UNZEN_DEMO_PORT: port },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
