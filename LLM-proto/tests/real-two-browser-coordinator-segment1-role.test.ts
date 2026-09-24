import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createSplitHarnessServer } from '../browser-harness/webgpu-2b-split/serve.mjs';

const servers: import('node:http').Server[] = [];
const MANIFEST_DIGEST = 'a'.repeat(64);
const tensors = [
  {
    name: 'boundary-residual',
    type: 'float32',
    dims: [1, 2, 4],
    bytes: 32,
    base64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  },
  {
    name: 'boundary-mlp',
    type: 'float32',
    dims: [1, 2, 4],
    bytes: 32,
    base64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  },
];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function startServer() {
  const { server, state } = createSplitHarnessServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, state };
}

async function registerWorker(
  baseUrl: string,
  workerId: string,
  role: 'segment0' | 'segment1' | 'standby',
) {
  const response = await fetch(`${baseUrl}/api/workers/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId, role }),
  });
  expect(response.status).toBe(201);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return {
    body: await response.json(),
    cookie: setCookie!.split(';', 1)[0],
  };
}

async function createCheckpoint(baseUrl: string, runId: string, cookie: string) {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/checkpoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      sourceWorkerId: 'browser-a',
      manifestDigest: MANIFEST_DIGEST,
      inputTokenIds: [1, 2],
      segmentExecutionMs: 12.5,
      tensors,
    }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

function resultPayload(
  workerId: string,
  checkpoint: Record<string, any>,
  overrides: Record<string, unknown>,
) {
  return {
    status: 'pass',
    manifestDigest: MANIFEST_DIGEST,
    checkpointId: checkpoint.checkpointId,
    checkpointDigest: checkpoint.checkpointDigest,
    checkpointSourceWorkerGeneration: checkpoint.sourceWorkerGeneration,
    segment0WorkerId: 'browser-a',
    segment1WorkerId: workerId,
    inputTokenIds: [1, 2],
    boundaryBytes: 64,
    segment0ExecutionMs: 12.5,
    segment1ExecutionMs: 7.25,
    top1TokenId: 3,
    top1Logit: 1.25,
    logitsShape: [1, 2, 8],
    directWorkerNetworking: false,
    relayOwner: 'coordinator',
    ...overrides,
  };
}

async function submitResult(
  baseUrl: string,
  runId: string,
  cookie: string,
  payload: Record<string, unknown>,
) {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(201);
}

async function fetchStoredResult(baseUrl: string, runId: string) {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/result`);
  expect(response.status).toBe(200);
  return response.json();
}

describe('split Coordinator segment1 role evidence', () => {
  it('overwrites a contradictory client segment1Role with the authenticated primary role', async () => {
    const { baseUrl, state } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const primary = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, 'canonical-primary-role', source.cookie);

    await submitResult(
      baseUrl,
      'canonical-primary-role',
      primary.cookie,
      resultPayload('browser-b', checkpoint, {
        segment1Role: 'standby',
        resumedFromCheckpoint: false,
      }),
    );

    const stored = await fetchStoredResult(baseUrl, 'canonical-primary-role');
    expect(stored.segment1Role).toBe('segment1');
    expect(stored.segment1WorkerIdentity).toMatchObject({
      workerId: 'browser-b',
      role: 'segment1',
      generation: 1,
    });
    expect(state.results.get('canonical-primary-role')?.segment1Role).toBe('segment1');
  });

  it('overwrites a contradictory client segment1Role with the authenticated standby role', async () => {
    const { baseUrl, state } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const standby = await registerWorker(baseUrl, 'browser-b-standby', 'standby');
    const checkpoint = await createCheckpoint(baseUrl, 'canonical-standby-role', source.cookie);

    await submitResult(
      baseUrl,
      'canonical-standby-role',
      standby.cookie,
      resultPayload('browser-b-standby', checkpoint, {
        segment1Role: 'segment1',
        resumedFromCheckpoint: true,
      }),
    );

    const stored = await fetchStoredResult(baseUrl, 'canonical-standby-role');
    expect(stored.segment1Role).toBe('standby');
    expect(stored.segment1WorkerIdentity).toMatchObject({
      workerId: 'browser-b-standby',
      role: 'standby',
      generation: 1,
    });
    expect(state.results.get('canonical-standby-role')?.segment1Role).toBe('standby');
  });
});
