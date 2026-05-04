import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const port = Number(process.env.UNZEN_E2E_PORT ?? 3100);
const origin = `http://127.0.0.1:${port}`;
const endpoint = `${origin}/api/unzen`;
const artifactDir = process.env.UNZEN_E2E_ARTIFACT_DIR
  ?? fileURLToPath(new URL('../test-results/nextjs-runtime-e2e', import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/manifest`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await delay(500);
  }

  throw new Error(`Next.js server did not become ready at ${origin}`);
}

async function expectJson(response, label) {
  assert(response.ok, `${label} failed with HTTP ${response.status}`);
  return response.json();
}

async function verifyHttpEndpoints() {
  const manifest = await expectJson(
    await fetch(`${endpoint}/manifest`),
    'GET /api/unzen/manifest'
  );

  const entry = manifest.functions?.jsonSchemaValidate;
  assert(entry, 'manifest is missing jsonSchemaValidate');
  assert(entry.runtime === 'quickjs', 'jsonSchemaValidate should use quickjs runtime');
  assert(
    typeof entry.codeUrl === 'string' && entry.codeUrl.startsWith(`${endpoint}/code/jsonSchemaValidate?v=`),
    `unexpected codeUrl: ${entry.codeUrl}`
  );

  const codeResponse = await fetch(entry.codeUrl);
  assert(codeResponse.ok, `GET ${entry.codeUrl} failed with HTTP ${codeResponse.status}`);
  const code = await codeResponse.text();
  assert(code.includes('function validate'), 'function code response is missing validation code');

  const execResult = await expectJson(
    await fetch(`${endpoint}/exec/jsonSchemaValidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        args: [
          { type: 'object', required: ['email'] },
          { email: 'a@example.com' },
        ],
      }),
    }),
    'POST /api/unzen/exec/jsonSchemaValidate'
  );
  assert(execResult.result?.valid === true, 'server exec result should be valid');

  const workerResponse = await fetch(`${origin}/unzen/worker.js`);
  assert(workerResponse.ok, `GET /unzen/worker.js failed with HTTP ${workerResponse.status}`);
  assert(
    workerResponse.headers.get('content-type')?.includes('javascript'),
    'worker asset should be served as JavaScript'
  );
}

async function saveBrowserArtifacts(context, page) {
  await mkdir(artifactDir, { recursive: true });

  const screenshotPath = join(artifactDir, 'browser-failure.png');
  const tracePath = join(artifactDir, 'trace.zip');

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.error(`Saved browser failure screenshot to ${screenshotPath}`);
  } catch (error) {
    console.error('Failed to save browser failure screenshot:', error);
  }

  try {
    await context.tracing.stop({ path: tracePath });
    console.error(`Saved Playwright trace to ${tracePath}`);
  } catch (error) {
    console.error('Failed to save Playwright trace:', error);
  }
}

async function verifyBrowserFlow() {
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });

      const button = page.getByRole('button', { name: 'Run validation' });
      await button.waitFor({ state: 'visible' });
      await button.click();

      const result = page.getByTestId('unzen-result');
      await result.waitFor({ state: 'visible' });
      await page.waitForFunction(() => {
        const text = document.querySelector('[data-testid="unzen-result"]')?.textContent;
        return text?.includes('"success": true');
      });

      const payloadText = await result.textContent();
      const payload = JSON.parse(payloadText ?? '');
      assert(payload.success === true, 'browser validation should succeed');
      assert(payload.result?.valid === true, 'browser validation result should be valid');
      assert(
        payload.diagnostics?.executedOn === 'browser',
        `expected browser execution, got ${payload.diagnostics?.executedOn}`
      );

      await context.tracing.stop();
    } catch (error) {
      await saveBrowserArtifacts(context, page);
      throw error;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => {
    server.once('exit', resolve);
  });

  server.kill('SIGTERM');

  const stopped = await Promise.race([
    exited.then(() => true),
    delay(5_000).then(() => false),
  ]);

  if (!stopped) {
    server.kill('SIGKILL');
    await exited;
  }
}

async function main() {
  const timeout = setTimeout(() => {
    console.error('Next.js runtime E2E timed out');
    process.exit(1);
  }, 90_000);
  const nextCli = fileURLToPath(import.meta.resolve('next/dist/bin/next'));

  const server = spawn(
    process.execPath,
    [nextCli, 'start', '-p', String(port), '-H', '127.0.0.1'],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        NEXT_PUBLIC_UNZEN_BASE_URL: endpoint,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer();
    await verifyHttpEndpoints();
    await verifyBrowserFlow();
    console.log('Next.js App Router runtime E2E passed');
  } finally {
    clearTimeout(timeout);
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
