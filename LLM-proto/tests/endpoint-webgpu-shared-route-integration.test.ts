import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HARNESSES = [
  'endpoint-tile-webgpu',
  'endpoint-five-way-tile-webgpu',
  'endpoint-embedding-tiled-webgpu',
  'endpoint-poststage-tiled-webgpu',
  'endpoint-embedding-eight-physical-webgpu',
] as const;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate an IPv4 test port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function fetchUntilReady(url: string, child: ChildProcessWithoutNullStreams): Promise<Response> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const stderr = child.stderr.read()?.toString() ?? '';
      throw new Error(`endpoint diagnostic server exited before becoming ready: ${stderr}`);
    }
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return response;
      lastError = new Error(`unexpected HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`endpoint diagnostic server did not become ready: ${String(lastError)}`);
}

describe('endpoint WebGPU shared-module server routes', () => {
  for (const harness of HARNESSES) {
    it(`serves the bounded-reader module graph for ${harness}`, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), `unzen-${harness}-`));
      const port = await getFreePort();
      const servePath = fileURLToPath(
        new URL(`../browser-harness/${harness}/serve.mjs`, import.meta.url),
      );
      const child = spawn(process.execPath, [servePath], {
        env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        const origin = `http://127.0.0.1:${port}`;
        const runnerResponse = await fetchUntilReady(`${origin}/runner.js`, child);
        const runnerSource = await runnerResponse.text();
        expect(runnerSource).toContain("../webgpu-2b-split/artifact-cache.js");

        const sharedModules = [
          '/webgpu-2b-split/artifact-cache.js',
          '/webgpu-2b-split/artifact-budget.js',
          '/webgpu-2b-split/execution-lifecycle.js',
        ];
        for (const pathname of sharedModules) {
          const response = await fetch(`${origin}${pathname}`, { cache: 'no-store' });
          expect(response.status, `${harness} ${pathname}`).toBe(200);
          expect(response.headers.get('content-type')).toContain('text/javascript');
          expect((await response.text()).length).toBeGreaterThan(0);
        }
      } finally {
        await stopProcess(child);
        await rm(dataDir, { recursive: true, force: true });
      }
    }, 15_000);
  }
});
