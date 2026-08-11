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
import { UNZEN_CODE_CACHE_NAME } from '@unzen/client/browser';

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

/** Wait until the root cache worker is active and controls the current page. */
async function waitForCacheWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/unzen-cache-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('cache worker did not claim the page')),
        10_000,
      );
      const done = () => {
        clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('controllerchange', done);
        resolve();
      };
      navigator.serviceWorker.addEventListener('controllerchange', done);
      if (navigator.serviceWorker.controller) done();
    });
  });
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

test.describe('persistent versioned code cache', () => {
  test('serves hash-verified function code while the browser is offline', async ({
    context,
    page,
  }) => {
    await page.goto('/');
    await waitForCacheWorker(page);

    const cached = await page.evaluate(async () => {
      const manifest = await fetch('/unzen/manifest').then((response) => response.json());
      const codeUrl = new URL(manifest.functions.multiply.codeUrl, location.href).href;
      const wasmUrl = new URL(
        manifest.functions.moonbitFibonacci.codeUrl,
        location.href,
      ).href;
      const first = await fetch(codeUrl);
      if (!first.ok) throw new Error(`initial code fetch failed: ${first.status}`);
      const firstBody = await first.text();
      const firstWasm = await fetch(wasmUrl);
      if (!firstWasm.ok) throw new Error(`initial Wasm fetch failed: ${firstWasm.status}`);
      const firstWasmBytes = await firstWasm.arrayBuffer();
      const toHash = async (bytes: ArrayBuffer) => {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(
          new Uint8Array(digest),
          (value) => value.toString(16).padStart(2, '0'),
        ).join('');
      };
      return {
        codeUrl,
        wasmUrl,
        firstBody,
        firstWasmHash: await toHash(firstWasmBytes),
      };
    });
    expect(cached.codeUrl).toContain('&h=sha256%3A');
    expect(cached.wasmUrl).toContain('&h=sha256%3A');
    await expect.poll(() => page.evaluate(async ({ cacheName, codeUrl, wasmUrl }) => {
      const cache = await caches.open(cacheName);
      const stored = await cache.match(codeUrl);
      const storedWasm = await cache.match(wasmUrl);
      const toHash = async (bytes: ArrayBuffer) => {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(
          new Uint8Array(digest),
          (value) => value.toString(16).padStart(2, '0'),
        ).join('');
      };
      return {
        storedBody: stored ? await stored.text() : null,
        storedWasmHash: storedWasm ? await toHash(await storedWasm.arrayBuffer()) : null,
      };
    }, {
      cacheName: UNZEN_CODE_CACHE_NAME,
      codeUrl: cached.codeUrl,
      wasmUrl: cached.wasmUrl,
    })).toEqual({
      storedBody: cached.firstBody,
      storedWasmHash: cached.firstWasmHash,
    });

    await context.setOffline(true);
    try {
      const offline = await page.evaluate(async ({ codeUrl, wasmUrl }) => {
        const codeResponse = await fetch(codeUrl);
        if (!codeResponse.ok) {
          throw new Error(`offline code fetch failed: ${codeResponse.status}`);
        }
        const wasmResponse = await fetch(wasmUrl);
        if (!wasmResponse.ok) {
          throw new Error(`offline Wasm fetch failed: ${wasmResponse.status}`);
        }
        const digest = await crypto.subtle.digest('SHA-256', await wasmResponse.arrayBuffer());
        return {
          code: await codeResponse.text(),
          wasmHash: Array.from(
            new Uint8Array(digest),
            (value) => value.toString(16).padStart(2, '0'),
          ).join(''),
        };
      }, { codeUrl: cached.codeUrl, wasmUrl: cached.wasmUrl });
      expect(offline.code).toBe(cached.firstBody);
      expect(offline.wasmHash).toBe(cached.firstWasmHash);
    } finally {
      await context.setOffline(false);
    }
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

test.describe('MoonBit JS-GC interop boundary (String + numeric array bridge)', () => {
  test('probes String success and Array boundary behavior', async ({ page }) => {
    await page.goto('/moonbit-interop-test.html');

    await expect(page.locator('#result')).toContainText('exports:', { timeout: 30_000 });
    await expect(page.locator('#result')).toContainText('reverse_array');
    await expect(page.locator('#result')).toContainText('unzen_array_i32_new');
    await expect(page.locator('#result')).toContainText('unzen_array_f64_get');
    // String boundary: input / output / round-trip / join all work via the
    // MoonBit JS String Builtins (use-js-builtin-string + js-string builtins).
    await expect(page.locator('#result')).toContainText('string_len("hello") [String input] = 5');
    await expect(page.locator('#result')).toContainText('make_string() [String output] = "hello"');
    await expect(page.locator('#result')).toContainText('echo("hello") [String round-trip] = "hello"');
    await expect(page.locator('#result')).toContainText('join_words("foo","bar") [String join] = "foobar"');
    await expect(page.locator('#result')).toContainText('weird_string() [__proto__ literal] = "__proto__"');
    await expect(page.locator('#result')).toContainText('empty_string() [empty literal] = ""');
    await expect(page.locator('#result')).toContainText('unicode_string() [Unicode literal] = "こんにちは"');
    // Array boundary: plain JS arrays are rejected at the wasm-gc boundary;
    // wasm-gc arrays return as opaque handles that only re-enter MoonBit
    // exports (handle round-trip), and cannot be read as plain JS arrays.
    await expect(page.locator('#result')).toContainText('sum_array(plain [1,2,3]) [Array input] ERR:');
    await expect(page.locator('#result')).toContainText('sum_array(opaque handle) [Array handle re-input] = 6');
    await expect(page.locator('#result')).toContainText(
      'reverse_array(opaque handle) [Array handle round-trip] = "opaque handle',
    );
    await expect(page.locator('#result')).toContainText('read opaque array as plain JS = "not readable"');
  });

  test('round-trips String and numeric arrays through production executors', async ({ page }) => {
    // The raw probe above exercises wasm directly; this test runs the SHIPPED
    // MoonBitSandboxExecutor and MoonBitWorkerSandboxExecutor so a regression
    // in compile options / import building is caught in real browsers.
    await page.goto('/moonbit-interop-executor-test.html');

    await expect(page.locator('#result')).toContainText('main echo = "hello"', { timeout: 30_000 });
    await expect(page.locator('#result')).toContainText('main join_words = "foobar"');
    await expect(page.locator('#result')).toContainText('main string_len = 5');
    await expect(page.locator('#result')).toContainText('main make_string = "hello"');
    await expect(page.locator('#result')).toContainText('main weird_string = "__proto__"');
    await expect(page.locator('#result')).toContainText('main empty_string = ""');
    await expect(page.locator('#result')).toContainText('main unicode_string = "こんにちは"');
    await expect(page.locator('#result')).toContainText(
      'main sum_array(plain) ERR: MoonBit supports number/boolean/bigint/string arguments only; '
      + 'arrays and objects cannot cross the wasm-gc boundary',
    );
    await expect(page.locator('#result')).toContainText('main make_array (opaque result) ERR:');
    await expect(page.locator('#result')).toContainText('main sum_array(ABI) = 6');
    await expect(page.locator('#result')).toContainText('main reverse_array(ABI) = [3,2,1]');
    await expect(page.locator('#result')).toContainText('main make_array(ABI) = [1,2,3]');
    await expect(page.locator('#result')).toContainText(
      'main scale_double_array(ABI) = [3,-4.5,8]',
    );

    await expect(page.locator('#result')).toContainText('worker echo = "hello"');
    await expect(page.locator('#result')).toContainText('worker join_words = "foobar"');
    await expect(page.locator('#result')).toContainText('worker string_len = 5');
    await expect(page.locator('#result')).toContainText('worker make_string = "hello"');
    await expect(page.locator('#result')).toContainText('worker weird_string = "__proto__"');
    await expect(page.locator('#result')).toContainText('worker empty_string = ""');
    await expect(page.locator('#result')).toContainText('worker unicode_string = "こんにちは"');
    await expect(page.locator('#result')).toContainText(
      'worker sum_array(plain) ERR: MoonBit supports number/boolean/bigint/string arguments only; '
      + 'arrays and objects cannot cross the wasm-gc boundary',
    );
    await expect(page.locator('#result')).toContainText('worker make_array (opaque result) ERR:');
    await expect(page.locator('#result')).toContainText('worker sum_array(ABI) = 6');
    await expect(page.locator('#result')).toContainText('worker reverse_array(ABI) = [3,2,1]');
    await expect(page.locator('#result')).toContainText('worker make_array(ABI) = [1,2,3]');
    await expect(page.locator('#result')).toContainText(
      'worker scale_double_array(ABI) = [3,-4.5,8]',
    );
  });
});
