import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  createSplitHarnessServer,
} from '../browser-harness/webgpu-2b-split/serve.mjs';

const servers: import('node:http').Server[] = [];
const MANIFEST_DIGEST = 'a'.repeat(64);
const OTHER_MANIFEST_DIGEST = 'b'.repeat(64);

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
  cookie?: string,
) {
  const response = await fetch(`${baseUrl}/api/workers/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ workerId, role }),
  });
  const setCookie = response.headers.get('set-cookie');
  return {
    response,
    body: await response.json(),
    cookie: setCookie ? setCookie.split(';', 1)[0] : cookie,
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

function validResult(
  segment1WorkerId: string,
  checkpoint: Record<string, any>,
  overrides: Record<string, unknown> = {},
) {
  return {
    status: 'pass',
    manifestDigest: checkpoint.manifestDigest ?? MANIFEST_DIGEST,
    checkpointId: checkpoint.checkpointId,
    checkpointDigest: checkpoint.checkpointDigest,
    checkpointSourceWorkerGeneration: checkpoint.sourceWorkerGeneration
      ?? checkpoint.sourceWorkerIdentity?.generation,
    segment0WorkerId: 'browser-a',
    segment1WorkerId,
    inputTokenIds: checkpoint.inputTokenIds ?? [1, 2],
    boundaryBytes: checkpoint.tensorBytes ?? 64,
    top1TokenId: 3,
    top1Logit: 1.25,
    logitsShape: [1, 2, 8],
    directWorkerNetworking: false,
    relayOwner: 'coordinator',
    ...overrides,
  };
}

async function fetchCheckpoint(baseUrl: string, runId: string) {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/checkpoint`);
  expect(response.status).toBe(200);
  return response.json();
}

describe('real two-browser split Coordinator harness', () => {
  it('relays exactly two tensors and assigns an immutable checkpoint ID/digest', async () => {
    const { baseUrl, state } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const posted = await postCheckpoint(baseUrl, 'run-1', registerA.cookie);

    expect(posted.response.status).toBe(201);
    expect(posted.body).toMatchObject({
      idempotent: false,
      relayOwner: 'coordinator',
      manifestDigest: MANIFEST_DIGEST,
      profileProbeConfirmed: true,
      sourceWorkerGeneration: 1,
      tensorBytes: 64,
    });
    expect(posted.body.checkpointId).toMatch(/^checkpoint-/);
    expect(posted.body.checkpointDigest).toMatch(/^[a-f0-9]{64}$/);

    const fetched = await fetchCheckpoint(baseUrl, 'run-1');
    expect(fetched).toMatchObject({
      runId: 'run-1',
      checkpointId: posted.body.checkpointId,
      checkpointDigest: posted.body.checkpointDigest,
      manifestDigest: MANIFEST_DIGEST,
      inputTokenIds: [1, 2],
      tensorBytes: 64,
      sourceWorkerId: 'browser-a',
      sourceWorkerIdentity: {
        workerId: 'browser-a',
        role: 'segment0',
        generation: 1,
      },
      relayOwner: 'coordinator',
      directWorkerNetworking: false,
      tensors,
    });
    expect(state.checkpoints.size).toBe(1);
  });

  it('accepts a result only when it binds the accepted checkpoint and a distinct profile', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const posted = await postCheckpoint(baseUrl, 'profile-ok', registerA.cookie);

    const result = await fetch(`${baseUrl}/api/runs/profile-ok/result`, {
      method: 'POST',
      headers: jsonHeaders(registerB.cookie),
      body: JSON.stringify(validResult('browser-b', posted.body)),
    });
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({
      idempotent: false,
      checkpointId: posted.body.checkpointId,
      checkpointDigest: posted.body.checkpointDigest,
      profileIsolationConfirmed: true,
      profileIsolationEvidence: {
        method: 'coordinator-issued-http-only-cookie',
        confirmed: true,
        sourceWorkerId: 'browser-a',
        sourceWorkerGeneration: 1,
        segment1WorkerId: 'browser-b',
        segment1WorkerGeneration: 1,
      },
    });
  });

  it('rejects missing or mismatched profile cookies on checkpoint and result writes', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1');

    const missingCheckpointCookie = await postCheckpoint(baseUrl, 'profile-auth', undefined);
    expect(missingCheckpointCookie.response.status).toBe(409);
    expect(missingCheckpointCookie.body).toMatchObject({ error: 'profile-probe-cookie-required' });

    const wrongCheckpointCookie = await postCheckpoint(baseUrl, 'profile-auth', registerB.cookie);
    expect(wrongCheckpointCookie.response.status).toBe(409);
    expect(wrongCheckpointCookie.body).toMatchObject({ error: 'profile-probe-cookie-mismatch' });

    const checkpoint = await postCheckpoint(baseUrl, 'profile-auth', registerA.cookie);
    expect(checkpoint.response.status).toBe(201);

    const missingResultCookie = await fetch(`${baseUrl}/api/runs/profile-auth/result`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(validResult('browser-b', checkpoint.body)),
    });
    expect(missingResultCookie.status).toBe(409);
    expect(await missingResultCookie.json()).toMatchObject({ error: 'profile-probe-cookie-required' });

    const wrongResultCookie = await fetch(`${baseUrl}/api/runs/profile-auth/result`, {
      method: 'POST',
      headers: jsonHeaders(registerA.cookie),
      body: JSON.stringify(validResult('browser-b', checkpoint.body)),
    });
    expect(wrongResultCookie.status).toBe(409);
    expect(await wrongResultCookie.json()).toMatchObject({ error: 'profile-probe-cookie-mismatch' });
  });

  it('rejects different worker IDs when both tabs share one profile cookie', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1', registerA.cookie);
    expect(registerB.body.profileProbeHash).toBe(registerA.body.profileProbeHash);

    const checkpoint = await postCheckpoint(baseUrl, 'profile-same', registerA.cookie);
    const result = await fetch(`${baseUrl}/api/runs/profile-same/result`, {
      method: 'POST',
      headers: jsonHeaders(registerB.cookie),
      body: JSON.stringify(validResult('browser-b', checkpoint.body)),
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      error: 'profile-isolation-not-proven',
      sourceWorkerId: 'browser-a',
      segment1WorkerId: 'browser-b',
    });
  });

  it('keeps a checkpoint bound to the source generation that actually wrote it', async () => {
    const { baseUrl } = await startServer();
    const registerA1 = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await postCheckpoint(baseUrl, 'profile-generation', registerA1.cookie);
    expect(checkpoint.response.status).toBe(201);

    const registerA2 = await registerWorker(baseUrl, 'browser-a', 'segment0');
    expect(registerA2.body.generation).toBe(2);
    expect(registerA2.body.profileProbeHash).not.toBe(registerA1.body.profileProbeHash);

    const result = await fetch(`${baseUrl}/api/runs/profile-generation/result`, {
      method: 'POST',
      headers: jsonHeaders(registerB.cookie),
      body: JSON.stringify(validResult('browser-b', checkpoint.body)),
    });
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({
      profileIsolationEvidence: {
        sourceWorkerGeneration: 1,
        segment1WorkerGeneration: 1,
      },
    });
  });

  it('rejects malformed checkpoint bindings and tensor encodings', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');

    const badBindings = [
      { manifestDigest: undefined },
      { manifestDigest: 'not-a-digest' },
      { inputTokenIds: [] },
      { inputTokenIds: [-1] },
    ];
    for (const [index, overrides] of badBindings.entries()) {
      const response = await postCheckpoint(baseUrl, `binding-${index}`, registerA.cookie, overrides);
      expect(response.response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'invalid-checkpoint-binding' });
    }

    const malformedTensorSets = [
      [{}, {}],
      [tensors[0], { ...tensors[1], name: tensors[0].name }],
      [{ ...tensors[0], bytes: 31 }, tensors[1]],
      [{ ...tensors[0], dims: [1, 2, 5] }, tensors[1]],
      [{ ...tensors[0], base64: '!!!!' }, tensors[1]],
    ];
    for (const [index, malformedTensors] of malformedTensorSets.entries()) {
      const response = await postCheckpoint(baseUrl, `malformed-${index}`, registerA.cookie, {
        tensors: malformedTensors,
      });
      expect(response.response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'invalid-boundary-tensor' });
    }
  });

  it('rejects incomplete or numerically invalid pass results', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await postCheckpoint(baseUrl, 'result-validation', registerA.cookie);

    const malformedResults = [
      { ...validResult('browser-b', checkpoint.body), status: 'failed' },
      validResult('browser-b', checkpoint.body, { top1Logit: null }),
      validResult('browser-b', checkpoint.body, { top1TokenId: 8 }),
      validResult('browser-b', checkpoint.body, { logitsShape: [1, 0, 8] }),
      validResult('browser-b', checkpoint.body, { boundaryBytes: 0 }),
    ];

    for (const malformedResult of malformedResults) {
      const response = await fetch(`${baseUrl}/api/runs/result-validation/result`, {
        method: 'POST',
        headers: jsonHeaders(registerB.cookie),
        body: JSON.stringify(malformedResult),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid-result-payload' });
    }
  });

  it('rejects manifest, checkpoint, producer generation, input and boundary mismatches', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await postCheckpoint(baseUrl, 'binding-mismatch', registerA.cookie);

    const cases = [
      [
        { manifestDigest: OTHER_MANIFEST_DIGEST },
        'result-manifest-mismatch',
      ],
      [
        { checkpointId: 'checkpoint-wrong' },
        'result-checkpoint-id-mismatch',
      ],
      [
        { checkpointDigest: 'c'.repeat(64) },
        'result-checkpoint-digest-mismatch',
      ],
      [
        { checkpointSourceWorkerGeneration: 2 },
        'result-checkpoint-generation-mismatch',
      ],
      [
        { inputTokenIds: [9, 9] },
        'result-input-token-mismatch',
      ],
      [
        { boundaryBytes: 32 },
        'result-boundary-byte-mismatch',
      ],
    ] as const;

    for (const [overrides, expectedError] of cases) {
      const response = await fetch(`${baseUrl}/api/runs/binding-mismatch/result`, {
        method: 'POST',
        headers: jsonHeaders(registerB.cookie),
        body: JSON.stringify(validResult('browser-b', checkpoint.body, overrides)),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: expectedError });
    }
  });

  it('treats identical checkpoint retries as idempotent but rejects replacement', async () => {
    const { baseUrl, state } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');

    const first = await postCheckpoint(baseUrl, 'immutable-checkpoint', registerA.cookie);
    expect(first.response.status).toBe(201);
    const retry = await postCheckpoint(baseUrl, 'immutable-checkpoint', registerA.cookie);
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({
      idempotent: true,
      checkpointId: first.body.checkpointId,
      checkpointDigest: first.body.checkpointDigest,
    });
    expect(state.checkpoints.size).toBe(1);

    const replacement = await postCheckpoint(baseUrl, 'immutable-checkpoint', registerA.cookie, {
      inputTokenIds: [22],
    });
    expect(replacement.response.status).toBe(409);
    expect(replacement.body).toMatchObject({ error: 'run-checkpoint-conflict' });

    const stored = await fetchCheckpoint(baseUrl, 'immutable-checkpoint');
    expect(stored.inputTokenIds).toEqual([1, 2]);
    expect(stored.checkpointId).toBe(first.body.checkpointId);
  });

  it('keeps a completed run immutable and makes exact result retries idempotent', async () => {
    const { baseUrl, state } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await postCheckpoint(baseUrl, 'completed-run', registerA.cookie);
    const payload = validResult('browser-b', checkpoint.body);

    const first = await fetch(`${baseUrl}/api/runs/completed-run/result`, {
      method: 'POST',
      headers: jsonHeaders(registerB.cookie),
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.resultDigest).toMatch(/^[a-f0-9]{64}$/);

    const retry = await fetch(`${baseUrl}/api/runs/completed-run/result`, {
      method: 'POST',
      headers: jsonHeaders(registerB.cookie),
      body: JSON.stringify(payload),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      idempotent: true,
      resultDigest: firstBody.resultDigest,
    });

    const conflictingResult = await fetch(`${baseUrl}/api/runs/completed-run/result`, {
      method: 'POST',
      headers: jsonHeaders(registerB.cookie),
      body: JSON.stringify({ ...payload, top1TokenId: 4 }),
    });
    expect(conflictingResult.status).toBe(409);
    expect(await conflictingResult.json()).toMatchObject({ error: 'run-result-conflict' });

    const conflictingCheckpoint = await postCheckpoint(baseUrl, 'completed-run', registerA.cookie, {
      inputTokenIds: [33],
    });
    expect(conflictingCheckpoint.response.status).toBe(409);
    expect(conflictingCheckpoint.body).toMatchObject({
      error: 'run-checkpoint-conflict',
      reason: 'completed-run-is-immutable',
    });
    expect(state.results.size).toBe(1);
  });

  it('does not let a standby overwrite a primary result for the same checkpoint', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const primary = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const standby = await registerWorker(baseUrl, 'browser-b-standby', 'standby');
    const checkpoint = await postCheckpoint(baseUrl, 'parallel-result', registerA.cookie);

    const primaryResult = await fetch(`${baseUrl}/api/runs/parallel-result/result`, {
      method: 'POST',
      headers: jsonHeaders(primary.cookie),
      body: JSON.stringify(validResult('browser-b', checkpoint.body)),
    });
    expect(primaryResult.status).toBe(201);

    const standbyResult = await fetch(`${baseUrl}/api/runs/parallel-result/result`, {
      method: 'POST',
      headers: jsonHeaders(standby.cookie),
      body: JSON.stringify(validResult('browser-b-standby', checkpoint.body, {
        resumedFromCheckpoint: true,
      })),
    });
    expect(standbyResult.status).toBe(409);
    expect(await standbyResult.json()).toMatchObject({ error: 'run-result-conflict' });

    const stored = await fetch(`${baseUrl}/api/runs/parallel-result/result`).then((response) => response.json());
    expect(stored.segment1WorkerId).toBe('browser-b');
    expect(stored.profileIsolationConfirmed).toBe(true);
  });

  it('allows a standby from a distinct profile to finish an otherwise uncompleted run', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const standby = await registerWorker(baseUrl, 'browser-b-standby', 'standby');
    const checkpoint = await postCheckpoint(baseUrl, 'resume-1', registerA.cookie);

    const result = await fetch(`${baseUrl}/api/runs/resume-1/result`, {
      method: 'POST',
      headers: jsonHeaders(standby.cookie),
      body: JSON.stringify(validResult('browser-b-standby', checkpoint.body, {
        resumedFromCheckpoint: true,
      })),
    });
    expect(result.status).toBe(201);
    expect(await fetch(`${baseUrl}/api/runs/resume-1/result`).then((response) => response.json())).toMatchObject({
      segment1WorkerId: 'browser-b-standby',
      resumedFromCheckpoint: true,
      profileIsolationConfirmed: true,
      checkpointId: checkpoint.body.checkpointId,
    });
  });

  it('rejects direct worker-to-worker networking', async () => {
    const { baseUrl } = await startServer();
    const direct = await fetch(`${baseUrl}/worker-peer/direct`, { method: 'POST' });
    expect(direct.status).toBe(403);
    expect(await direct.json()).toMatchObject({ rejected: true });
  });
});
