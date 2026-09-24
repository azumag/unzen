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
  role: 'segment0' | 'segment1',
) {
  const response = await fetch(`${baseUrl}/api/workers/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId, role }),
  });
  const setCookie = response.headers.get('set-cookie');
  return {
    response,
    body: await response.json(),
    cookie: setCookie?.split(';', 1)[0],
  };
}

function jsonHeaders(cookie?: string) {
  return {
    'Content-Type': 'application/json',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function checkpointPayload(overrides: Record<string, unknown> = {}) {
  return {
    sourceWorkerId: 'browser-a',
    manifestDigest: MANIFEST_DIGEST,
    inputTokenIds: [1, 2],
    segmentExecutionMs: 12.5,
    tensors,
    ...overrides,
  };
}

async function postCheckpoint(
  baseUrl: string,
  runId: string,
  cookie: string | undefined,
  overrides: Record<string, unknown> = {},
) {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/checkpoint`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(checkpointPayload(overrides)),
  });
  return { response, body: await response.json() };
}

async function getCheckpoint(baseUrl: string, runId: string) {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/checkpoint`);
  expect(response.status).toBe(200);
  return response.json();
}

function validResult(
  segment1WorkerId: string,
  checkpoint: Record<string, any>,
  overrides: Record<string, unknown> = {},
) {
  return {
    status: 'pass',
    manifestDigest: checkpoint.manifestDigest,
    checkpointId: checkpoint.checkpointId,
    checkpointDigest: checkpoint.checkpointDigest,
    checkpointSourceWorkerGeneration: checkpoint.sourceWorkerIdentity.generation,
    segment0WorkerId: checkpoint.sourceWorkerId,
    segment1WorkerId,
    inputTokenIds: checkpoint.inputTokenIds,
    boundaryBytes: checkpoint.tensorBytes,
    segment0ExecutionMs: checkpoint.segmentExecutionMs,
    segment1ExecutionMs: 7.25,
    top1TokenId: 3,
    top1Logit: 1.25,
    logitsShape: [1, 2, 8],
    directWorkerNetworking: false,
    relayOwner: 'coordinator',
    resumedFromCheckpoint: false,
    ...overrides,
  };
}

describe('real two-browser Coordinator execution timing integrity', () => {
  it('rejects malformed checkpoint execution timing without mutating run state', async () => {
    const { baseUrl, state } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');

    const invalidTimings = [undefined, null, '12.5', -0.1];
    for (const [index, segmentExecutionMs] of invalidTimings.entries()) {
      const response = await postCheckpoint(baseUrl, `bad-checkpoint-timing-${index}`, registerA.cookie, {
        segmentExecutionMs,
      });
      expect(response.response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: 'invalid-checkpoint-binding',
        reason: 'invalid-segment-execution-ms',
      });
    }

    expect(state.checkpoints.size).toBe(0);
  });

  it('binds checkpoint execution timing into the checkpoint digest and idempotency key', async () => {
    const { baseUrl, state } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');

    const first = await postCheckpoint(baseUrl, 'checkpoint-timing-digest', registerA.cookie);
    expect(first.response.status).toBe(201);
    const retry = await postCheckpoint(baseUrl, 'checkpoint-timing-digest', registerA.cookie);
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({
      idempotent: true,
      checkpointDigest: first.body.checkpointDigest,
    });

    const changedTiming = await postCheckpoint(baseUrl, 'checkpoint-timing-digest', registerA.cookie, {
      segmentExecutionMs: 12.6,
    });
    expect(changedTiming.response.status).toBe(409);
    expect(changedTiming.body).toMatchObject({ error: 'run-checkpoint-conflict' });
    expect(state.checkpoints.size).toBe(1);
  });

  it('rejects malformed or checkpoint-divergent result timing before storing a result', async () => {
    const { baseUrl, state } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const posted = await postCheckpoint(baseUrl, 'result-timing-validation', registerA.cookie);
    expect(posted.response.status).toBe(201);
    const checkpoint = await getCheckpoint(baseUrl, 'result-timing-validation');

    const malformedCases = [
      { segment0ExecutionMs: null },
      { segment0ExecutionMs: '12.5' },
      { segment1ExecutionMs: null },
      { segment1ExecutionMs: -1 },
    ];
    for (const overrides of malformedCases) {
      const response = await fetch(`${baseUrl}/api/runs/result-timing-validation/result`, {
        method: 'POST',
        headers: jsonHeaders(registerB.cookie),
        body: JSON.stringify(validResult('browser-b', checkpoint, overrides)),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid-result-payload' });
    }

    const mismatch = await fetch(`${baseUrl}/api/runs/result-timing-validation/result`, {
      method: 'POST',
      headers: jsonHeaders(registerB.cookie),
      body: JSON.stringify(validResult('browser-b', checkpoint, {
        segment0ExecutionMs: checkpoint.segmentExecutionMs + 0.1,
      })),
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      error: 'result-segment0-execution-ms-mismatch',
      expectedSegment0ExecutionMs: checkpoint.segmentExecutionMs,
    });
    expect(state.results.size).toBe(0);
  });

  it('binds accepted result timings into result idempotency', async () => {
    const { baseUrl, state } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const posted = await postCheckpoint(baseUrl, 'result-timing-digest', registerA.cookie, {
      segmentExecutionMs: 0,
    });
    expect(posted.response.status).toBe(201);
    const checkpoint = await getCheckpoint(baseUrl, 'result-timing-digest');
    const payload = validResult('browser-b', checkpoint, { segment1ExecutionMs: 0 });

    const first = await fetch(`${baseUrl}/api/runs/result-timing-digest/result`, {
      method: 'POST',
      headers: jsonHeaders(registerB.cookie),
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.resultDigest).toMatch(/^[a-f0-9]{64}$/);

    const retry = await fetch(`${baseUrl}/api/runs/result-timing-digest/result`, {
      method: 'POST',
      headers: jsonHeaders(registerB.cookie),
      body: JSON.stringify(payload),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      idempotent: true,
      resultDigest: firstBody.resultDigest,
    });

    const changedTiming = await fetch(`${baseUrl}/api/runs/result-timing-digest/result`, {
      method: 'POST',
      headers: jsonHeaders(registerB.cookie),
      body: JSON.stringify({ ...payload, segment1ExecutionMs: 0.1 }),
    });
    expect(changedTiming.status).toBe(409);
    expect(await changedTiming.json()).toMatchObject({ error: 'run-result-conflict' });
    expect(state.results.size).toBe(1);
  });
});