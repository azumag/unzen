/**
 * Browser-level E2E stories for the demo page (issue #104 acceptance).
 *
 * Runs against the real demo server (playwright.config.ts webServer) and the
 * real client SDK. The only injection is page.route() on /worker.js, which
 * swaps the QuickJS worker for a deterministic fake:
 *
 * - broken worker (top-level throw)  → browser attempt fails → server fallback
 * - hanging worker (init ok, execute dropped) → run stays busy → cancel path
 *
 * No production code is modified by the specs.
 */
import { test, expect, type Page } from '@playwright/test';

/** Replace /worker.js with a worker that throws during load (init failure). */
async function injectBrokenWorker(page: Page): Promise<void> {
  await page.route('**/worker.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'throw new Error("injected worker init failure");',
    }),
  );
}

/** Replace /worker.js with a worker that inits but never executes (hang). */
async function injectHangingWorker(page: Page): Promise<void> {
  await page.route('**/worker.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        self.onmessage = (e) => {
          if (e.data && e.data.type === 'init') {
            self.postMessage({
              type: 'init-result',
              success: true,
              protocolVersion: e.data.protocolVersion,
              generationId: e.data.generationId,
            });
          }
          // execute / cancel messages intentionally dropped → request hangs
        };
      `,
    }),
  );
}

test.describe('browser execution (happy path)', () => {
  test('multiply runs in the browser sandbox and succeeds', async ({ page }) => {
    await page.goto('/');

    await page.click('#multiply-run');

    await expect(page.locator('#demo-multiply')).toHaveAttribute('data-state', 'succeeded');
    await expect(page.locator('#multiply-result')).toBeVisible();
    await expect(page.locator('#multiply-result')).toContainText('35');
  });

  test('status region is a polite live region that announces the outcome', async ({ page }) => {
    await page.goto('/');
    const status = page.locator('#multiply-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');

    await page.click('#multiply-run');
    await expect(page.locator('#demo-multiply')).toHaveAttribute('data-state', 'succeeded');
    await expect(status.locator('.status-text')).not.toBeEmpty();
  });
});

test.describe('server fallback (deterministic worker failure)', () => {
  test('browser failure falls back to the server and reports the attempt chain', async ({ page }) => {
    await injectBrokenWorker(page);
    await page.goto('/');

    const execRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/unzen/exec/')) execRequests.push(req.url());
    });
    // Keep the server execution observable: delay the /exec response so the
    // live `running-on-server` state can be asserted (fallback is otherwise
    // instantaneous against localhost).
    await page.route('**/unzen/exec/**', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });

    await page.click('#multiply-run');

    // The live chain must show the browser → server transition (AC: the
    // fallback is visible while it happens, not only after the fact).
    await expect(page.locator('#demo-multiply')).toHaveAttribute(
      'data-state',
      'running-on-server',
      { timeout: 10_000 },
    );
    await expect(page.locator('#demo-multiply')).toHaveAttribute('data-state', 'succeeded');
    await expect(page.locator('#multiply-result')).toContainText('35');

    // Exactly one server execution happened for this run.
    expect(execRequests).toHaveLength(1);

    // The diagnostics panel reports the fallback explicitly.
    await expect(page.locator('#multiply-result')).toContainText('fallback');
  });
});

test.describe('cancellation (hanging worker)', () => {
  test('cancel stops a hung run as cancelled and never starts server fallback', async ({ page }) => {
    await injectHangingWorker(page);
    await page.goto('/');

    const execRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/unzen/exec/')) execRequests.push(req.url());
    });

    await page.click('#multiply-run');
    await expect(page.locator('#multiply-cancel')).toBeVisible();
    await expect(page.locator('#demo-multiply')).toHaveAttribute(
      'data-state',
      'running-in-browser',
    );

    await page.click('#multiply-cancel');

    // cancelling → cancelled (issue #105: cancel is final, no fallback).
    await expect(page.locator('#demo-multiply')).toHaveAttribute('data-state', 'cancelled', {
      timeout: 10_000,
    });
    expect(execRequests).toHaveLength(0);
  });

  test('the run button cannot be double-submitted while a run is busy', async ({ page }) => {
    await injectHangingWorker(page);
    await page.goto('/');

    await page.click('#multiply-run');
    await expect(page.locator('#demo-multiply')).toHaveAttribute('data-state', 'running-in-browser');

    // The run button is disabled while busy; a second click is ignored.
    await expect(page.locator('#multiply-run')).toBeDisabled();
    await page.click('#multiply-run', { force: true }).catch(() => {});
    await page.click('#multiply-cancel');
    await expect(page.locator('#demo-multiply')).toHaveAttribute('data-state', 'cancelled');
  });
});

test.describe('input error and retry', () => {
  test('invalid input fails with input error and retry starts a fresh run', async ({ page }) => {
    await page.goto('/');

    // Multiply: invalid numbers → validation failure before any SDK call.
    await page.fill('#num1', 'abc');
    await page.click('#multiply-run');

    await expect(page.locator('#demo-multiply')).toHaveAttribute('data-state', 'failed');
    await expect(page.locator('#num1-error')).toBeVisible();

    // Retry with valid input on the same section.
    await page.fill('#num1', '5');
    await page.click('#multiply-retry');
    await expect(page.locator('#demo-multiply')).toHaveAttribute('data-state', 'succeeded');
    await expect(page.locator('#multiply-result')).toContainText('35');
  });
});

test.describe('accessibility', () => {
  test('the whole run flow works with keyboard only', async ({ page }) => {
    await page.goto('/');

    // Focus the first field of the multiply demo, then Tab to the Run button
    // and activate it with Enter.
    await page.locator('#num1').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    await expect(page.locator('#demo-multiply')).toHaveAttribute('data-state', 'succeeded');
  });
});

test.describe('narrow viewport', () => {
  test('the page has no horizontal overflow on a phone-sized viewport', async ({ page }) => {
    await page.goto('/');

    const overflow = await page.evaluate(
      () => document.scrollingElement!.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);

    // A demo still completes on the narrow layout.
    await page.click('#multiply-run');
    await expect(page.locator('#demo-multiply')).toHaveAttribute('data-state', 'succeeded');
  });
});

test.describe('MoonBit worker (real wasm-gc in the browser)', () => {
  test('executes a fibonacci module in the dedicated worker', async ({ page }) => {
    await page.goto('/moonbit-test.html');

    await expect(page.locator('#result')).toHaveText('fib10=55 fib15=610', {
      timeout: 30_000,
    });
  });

  test('terminates a hung export by hard timeout and cancel, then recovers', async ({ page }) => {
    await page.goto('/moonbit-hang-test.html');

    await expect(page.locator('#result')).toContainText('bounded_hang(1) = 1', {
      timeout: 30_000,
    });
    // hang_forever must be force-terminated (deadline exceeded), not resolved.
    await expect(page.locator('#result')).toContainText('hang_forever → DEADLINE_EXCEEDED', {
      timeout: 30_000,
    });
    // The executor recovers on a fresh generation.
    await expect(page.locator('#result')).toContainText('recovery fib(10) = 55');
    // A real Worker.terminate() was called for the hard timeout.
    await expect(page.locator('#result')).toContainText('worker.terminate() calls: 2');
    // Cancel during a hang settles as cancelled (never fallback).
    await expect(page.locator('#result')).toContainText('cancel hang_forever → CANCELLED');
    await expect(page.locator('#result')).toContainText('recovery fib(15) = 610');
    // The main thread kept ticking DURING the hangs (positive tick delta over
    // the actual execution window — a zero would mean the worker blocked it).
    for (const label of ['deadline', 'cancel']) {
      const line = await page.locator('#result').textContent();
      const match = line?.match(new RegExp(`ticks during ${label} hang: (\\d+)`));
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThan(0);
    }
    await expect(page.locator('#result')).toContainText('main-thread responsive: yes');
  });
});
