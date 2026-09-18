import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
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

const EIGHT_PHYSICAL_TILE_BYTES = 131_334_144;
const EIGHT_PHYSICAL_ROWS_PER_TILE = 16_032;
const EIGHT_PHYSICAL_GRAPH_FILE = 'embedding-offset-0.onnx';
const EIGHT_PHYSICAL_GRAPH_SHA256 = '70a56611e458eb6af8333329424756275aa5ad6b08467fa51912532867b6ce50';
const MAX_PREFLIGHT_REPORT_BYTES = 16 * 1024 * 1024;

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

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('endpoint diagnostic server did not exit')), 5_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
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

async function serverEnvironment(
  harness: (typeof HARNESSES)[number],
  dataDir: string,
  port: number,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, PORT: String(port) };
  if (harness !== 'endpoint-embedding-eight-physical-webgpu') return env;

  const graphPath = join(dataDir, EIGHT_PHYSICAL_GRAPH_FILE);
  const preflightPath = join(dataDir, 'preflight.json');
  await writeFile(graphPath, new Uint8Array(260));

  const payloads = Array.from({ length: 8 }, (_, index) => ({
    index,
    file: `payload-${String(index).padStart(4, '0')}.bin`,
    bytes: EIGHT_PHYSICAL_TILE_BYTES,
    sha256: String(index + 1).repeat(64).slice(0, 64),
    sourceOffsetBytes: index * EIGHT_PHYSICAL_TILE_BYTES,
    sourceEndOffsetBytesExclusive: (index + 1) * EIGHT_PHYSICAL_TILE_BYTES,
  }));
  const runtimePlan = payloads.map((payload, index) => ({
    tileIndex: index,
    startRow: index * EIGHT_PHYSICAL_ROWS_PER_TILE,
    endRowExclusive: (index + 1) * EIGHT_PHYSICAL_ROWS_PER_TILE,
    physicalArtifactIndex: index,
    payloadFile: payload.file,
    expectedPayloadBytes: payload.bytes,
    expectedPayloadSha256: payload.sha256,
    sourceOffsetBytes: payload.sourceOffsetBytes,
    sourceEndOffsetBytesExclusive: payload.sourceEndOffsetBytesExclusive,
    graphFile: EIGHT_PHYSICAL_GRAPH_FILE,
    expectedGraphBytes: 260,
    expectedGraphSha256: EIGHT_PHYSICAL_GRAPH_SHA256,
    graphExternalDataPath: 'payload-0000.bin',
    artifactByteOffset: 0,
    byteLength: EIGHT_PHYSICAL_TILE_BYTES,
  }));
  const preflight = {
    kind: 'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-bundle-preflight',
    schemaVersion: '1.0.0',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    candidatePhysicalArtifactCount: 8,
    sourceGraphSha256: 'a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46',
    sourceExternalData: {
      fileName: 'model_q4.onnx_data',
      bytes: 1_692_672_000,
      sha256: '07cc629ef2cb7fdb18615ce2e4f3774f763e6fc840207d772a8b511eead36647',
    },
    manifestPayloadSetSha256: 'f'.repeat(64),
    evidenceBoundary: 'actual-file-integrity-preflight-only',
    graph: {
      file: EIGHT_PHYSICAL_GRAPH_FILE,
      bytes: 260,
      sha256: EIGHT_PHYSICAL_GRAPH_SHA256,
    },
    payloads,
    runtimePlan,
  };
  await writeFile(preflightPath, `${JSON.stringify(preflight)}\n`);
  env.PREFLIGHT_REPORT = preflightPath;
  env.GRAPH_PATH = graphPath;
  return env;
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
        env: await serverEnvironment(harness, dataDir, port),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        const origin = `http://127.0.0.1:${port}`;
        const runnerResponse = await fetchUntilReady(`${origin}/runner.js`, child);
        const runnerSource = await runnerResponse.text();
        expect(runnerSource).toContain('../webgpu-2b-split/artifact-cache.js');

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

  it('rejects an oversized 8-physical preflight report before listening', async () => {
    const harness = 'endpoint-embedding-eight-physical-webgpu';
    const dataDir = await mkdtemp(join(tmpdir(), 'unzen-endpoint-eight-physical-oversized-'));
    const port = await getFreePort();
    const preflightPath = join(dataDir, 'oversized-preflight.json');
    const graphPath = join(dataDir, EIGHT_PHYSICAL_GRAPH_FILE);
    const servePath = fileURLToPath(
      new URL(`../browser-harness/${harness}/serve.mjs`, import.meta.url),
    );
    await writeFile(preflightPath, '');
    await truncate(preflightPath, MAX_PREFLIGHT_REPORT_BYTES + 1);

    const child = spawn(process.execPath, [servePath], {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        PREFLIGHT_REPORT: preflightPath,
        GRAPH_PATH: graphPath,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const exitCode = await waitForExit(child);
      const stderr = child.stderr.read()?.toString() ?? '';
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(`PREFLIGHT_REPORT exceeds ${MAX_PREFLIGHT_REPORT_BYTES} bytes`);
    } finally {
      await stopProcess(child);
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 10_000);
});
