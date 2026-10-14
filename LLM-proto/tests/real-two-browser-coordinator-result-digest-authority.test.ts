import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  RESULT_DIGEST_AUTHORITY,
  createSplitHarnessServer,
  resultDigestInputFor,
} from '../browser-harness/webgpu-2b-split/serve.mjs';

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
  return {
    response,
    body: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0],
  };
}

function jsonHeaders(cookie?: string) {
  return {
    'Content-Type': 'application/json',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

async function postCheckpoint(
  baseUrl: string,
  runId: string,
  cookie: string | undefined,
) {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/checkpoint`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({
      sourceWorkerId: 'browser-a',
      manifestDigest: MANIFEST_DIGEST,
      inputTokenIds: [1, 2],
      segmentExecutionMs: 12.5,
      tensors,
    }),
  });
  return { response, body: await response.json() };
}

async function getCheckpoint(baseUrl: string, runId: string) {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/checkpoint`);
  expect(response.status).toBe(200);
  return response.json();
}

function supplementalFields(tag: string) {
  return {
    schemaVersion: `1.0.${tag}`,
    kind: `unzen-real-two-browser-webgpu-split-run-${tag}`,
    artifactCache: {
      segment0: { cacheHit: tag === 'a' },
      segment1: { cacheHit: tag === 'b' },
      allCacheHits: tag === 'a',
    },
    adapter: { vendor: `vendor-${tag}`, architecture: '', description: '', isFallbackAdapter: false },
    logitsFinite: tag === 'a',
    logitsElementCount: tag === 'a' ? 16 : 32,
    artifactLayout: 'per-segment-external-data',
    segmentExternalData: [{ path: `weights-${tag}.bin`, bytes: 1024 }],
  };
}

function resultPayload(
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
    ...supplementalFields('a'),
    ...overrides,
  };
}

async function postResult(
  baseUrl: string,
  runId: string,
  cookie: string | undefined,
  payload: Record<string, unknown>,
) {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/result`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

async function getStoredResult(baseUrl: string, runId: string) {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/result`);
  expect(response.status).toBe(200);
  return response.json();
}

describe('Coordinator result digest authority', () => {
  it('declares a digest scope that matches the hashed projection exactly', () => {
    const body = {
      checkpointId: 'checkpoint-00000000-0000-4000-8000-000000000000',
      checkpointDigest: 'c'.repeat(64),
      checkpointSourceWorkerGeneration: 1,
      manifestDigest: MANIFEST_DIGEST,
      inputTokenIds: [1, 2],
      boundaryBytes: 64,
      segment0ExecutionMs: 12.5,
      segment1ExecutionMs: 7.25,
      top1TokenId: 3,
      top1Logit: 1.25,
      logitsShape: [1, 2, 8],
      resumedFromCheckpoint: false,
    };
    const checkpoint = { sourceWorkerIdentity: { workerId: 'browser-a' } };
    const segment1WorkerIdentity = {
      workerId: 'browser-b',
      role: 'segment1',
      generation: 1,
      profileProbeHash: 'd'.repeat(64),
    };

    const projected = Object.keys(resultDigestInputFor(body, checkpoint, segment1WorkerIdentity)).sort();
    expect(projected).toEqual([...RESULT_DIGEST_AUTHORITY.digestBound].sort());
  });

  it('keeps unattested supplemental fields and validated gates out of the digest scope', () => {
    const digestBound = new Set(RESULT_DIGEST_AUTHORITY.digestBound);
    for (const field of [...RESULT_DIGEST_AUTHORITY.supplemental, ...RESULT_DIGEST_AUTHORITY.validatedGate]) {
      expect(digestBound.has(field)).toBe(false);
    }
    // segment0WorkerId and segment1WorkerIdentity are deliberately in both
    // lists: the Coordinator derives them, and the derived value is digested.
    expect(RESULT_DIGEST_AUTHORITY.coordinatorDerived).toContain('segment0WorkerId');
    expect(RESULT_DIGEST_AUTHORITY.coordinatorDerived).toContain('segment1WorkerIdentity');
    // A field may not be classified twice inside one unattested class.
    const seen = new Set<string>();
    for (const field of [...RESULT_DIGEST_AUTHORITY.supplemental, ...RESULT_DIGEST_AUTHORITY.validatedGate]) {
      expect(seen.has(field)).toBe(false);
      seen.add(field);
    }
  });

  it('documents every classified field in the split-harness evidence contract', () => {
    const contract = readFileSync(
      new URL('../browser-harness/webgpu-2b-split/EVIDENCE-CONTRACT.md', import.meta.url),
      'utf8',
    );
    const allFields = [
      ...RESULT_DIGEST_AUTHORITY.digestBound,
      ...RESULT_DIGEST_AUTHORITY.coordinatorDerived,
      ...RESULT_DIGEST_AUTHORITY.supplemental,
      ...RESULT_DIGEST_AUTHORITY.validatedGate,
    ];
    for (const field of allFields) {
      expect(contract).toContain(`\`${field}\``);
    }
    expect(contract).toContain('core-result digest');
    expect(contract).toContain('not treat `resultDigest` as a digest of the full stored JSON record');
  });

  it('keeps a supplemental-only retry idempotent without replacing the stored record', async () => {
    const { baseUrl, state } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const runId = 'supplemental-retry-idempotent';

    const posted = await postCheckpoint(baseUrl, runId, source.cookie);
    expect(posted.response.status).toBe(201);
    const checkpoint = await getCheckpoint(baseUrl, runId);

    const first = await postResult(baseUrl, runId, consumer.cookie, resultPayload('browser-b', checkpoint));
    expect(first.response.status).toBe(201);
    expect(first.body.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    const storedFirst = await getStoredResult(baseUrl, runId);

    const retry = await postResult(
      baseUrl,
      runId,
      consumer.cookie,
      resultPayload('browser-b', checkpoint, supplementalFields('b')),
    );
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({
      idempotent: true,
      resultDigest: first.body.resultDigest,
    });

    const storedAfterRetry = await getStoredResult(baseUrl, runId);
    expect(storedAfterRetry).toEqual(storedFirst);
    expect(state.results.size).toBe(1);
    expect(storedAfterRetry.schemaVersion).toBe(supplementalFields('a').schemaVersion);
    expect(storedAfterRetry.adapter).toEqual(supplementalFields('a').adapter);
  });

  it('treats caller key order of supplemental nested objects as irrelevant to the result identity', async () => {
    const { baseUrl } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const runId = 'supplemental-key-order';

    const posted = await postCheckpoint(baseUrl, runId, source.cookie);
    expect(posted.response.status).toBe(201);
    const checkpoint = await getCheckpoint(baseUrl, runId);

    const first = await postResult(baseUrl, runId, consumer.cookie, resultPayload('browser-b', checkpoint));
    expect(first.response.status).toBe(201);

    const reversedKeys = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).reverse());
    const retry = await postResult(
      baseUrl,
      runId,
      consumer.cookie,
      resultPayload('browser-b', checkpoint, {
        artifactCache: reversedKeys(supplementalFields('a').artifactCache as Record<string, unknown>),
        segmentExternalData: [{ path: 'weights-a.bin', bytes: 1024 }],
      }),
    );
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({
      idempotent: true,
      resultDigest: first.body.resultDigest,
    });
  });

  it('still rejects a retry that changes a digest-bound core field', async () => {
    const { baseUrl, state } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const runId = 'core-field-conflict';

    const posted = await postCheckpoint(baseUrl, runId, source.cookie);
    expect(posted.response.status).toBe(201);
    const checkpoint = await getCheckpoint(baseUrl, runId);

    const first = await postResult(baseUrl, runId, consumer.cookie, resultPayload('browser-b', checkpoint));
    expect(first.response.status).toBe(201);

    const conflict = await postResult(
      baseUrl,
      runId,
      consumer.cookie,
      resultPayload('browser-b', checkpoint, { top1TokenId: 4 }),
    );
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: 'run-result-conflict',
      reason: 'completed-run-is-immutable',
      existingResultDigest: first.body.resultDigest,
    });
    expect(state.results.size).toBe(1);
  });

  it('rejects a differing validated gate before any result state exists', async () => {
    const { baseUrl, state } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const runId = 'validated-gate-rejection';

    const posted = await postCheckpoint(baseUrl, runId, source.cookie);
    expect(posted.response.status).toBe(201);
    const checkpoint = await getCheckpoint(baseUrl, runId);

    const rejected = await postResult(
      baseUrl,
      runId,
      consumer.cookie,
      resultPayload('browser-b', checkpoint, { relayOwner: 'worker' }),
    );
    expect(rejected.response.status).toBe(400);
    expect(rejected.body).toMatchObject({
      error: 'invalid-result-payload',
      reason: 'relay-semantics-mismatch',
    });
    expect(state.results.size).toBe(0);
  });
});
