import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  RESULT_COORDINATOR_DERIVED_FIELDS,
  RESULT_DIGEST_BOUND_FIELDS,
  RESULT_SUPPLEMENTAL_FIELDS,
  createSplitHarnessServer,
  resultDigestProjection,
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
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, state };
}

async function postJson(url: string, body: unknown, cookie?: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  return {
    response,
    body: await response.json(),
    cookie: setCookie ? setCookie.split(';', 1)[0] : cookie,
  };
}

async function registerWorker(baseUrl: string, workerId: string, role: 'segment0' | 'segment1') {
  return postJson(`${baseUrl}/api/workers/register`, { workerId, role });
}

async function createCheckpoint(baseUrl: string, runId: string, cookie: string | undefined) {
  return postJson(`${baseUrl}/api/runs/${runId}/checkpoint`, {
    sourceWorkerId: 'browser-a',
    manifestDigest: MANIFEST_DIGEST,
    inputTokenIds: [1, 2],
    segmentExecutionMs: 12.5,
    tensors,
  }, cookie);
}

// Mirrors the fields the real browser runner (`runner-v3.js`) submits, including
// the supplemental telemetry that is intentionally outside `resultDigest`.
function representativeReport(checkpoint: Record<string, any>): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-real-two-browser-webgpu-split-run',
    status: 'pass',
    manifestDigest: MANIFEST_DIGEST,
    checkpointId: checkpoint.checkpointId,
    checkpointDigest: checkpoint.checkpointDigest,
    checkpointSourceWorkerGeneration: checkpoint.sourceWorkerGeneration,
    segment0WorkerId: 'browser-a',
    segment1WorkerId: 'browser-b',
    resumedFromCheckpoint: false,
    inputTokenIds: [1, 2],
    boundaryBytes: 64,
    segment0ExecutionMs: 12.5,
    segment1ExecutionMs: 7.25,
    artifactCache: {
      segment0: { allCacheHits: true, budget: { verdict: 'pass' } },
      segment1: { allCacheHits: false, budget: { verdict: 'pass' } },
    },
    top1TokenId: 3,
    top1Logit: 1.25,
    logitsShape: [1, 2, 8],
    logitsFinite: true,
    logitsElementCount: 16,
    adapter: { vendor: 'apple', architecture: 'metal-3', isFallbackAdapter: false },
    directWorkerNetworking: false,
    relayOwner: 'coordinator',
    artifactLayout: 'per-segment-external-data',
    segmentExternalData: [{ path: 'segment-0.onnx.data', byteLength: 32 }],
  };
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const CLASSIFIED_FIELDS = new Set([
  ...RESULT_DIGEST_BOUND_FIELDS,
  ...RESULT_COORDINATOR_DERIVED_FIELDS,
  ...RESULT_SUPPLEMENTAL_FIELDS,
]);

describe('split Coordinator resultDigest scope contract', () => {
  it('keeps the three classification lists disjoint and non-overlapping', () => {
    expect(RESULT_DIGEST_BOUND_FIELDS.length).toBe(new Set(RESULT_DIGEST_BOUND_FIELDS).size);
    expect(RESULT_COORDINATOR_DERIVED_FIELDS.length).toBe(new Set(RESULT_COORDINATOR_DERIVED_FIELDS).size);
    expect(RESULT_SUPPLEMENTAL_FIELDS.length).toBe(new Set(RESULT_SUPPLEMENTAL_FIELDS).size);
    expect(CLASSIFIED_FIELDS.size)
      .toBe(RESULT_DIGEST_BOUND_FIELDS.length
        + RESULT_COORDINATOR_DERIVED_FIELDS.length
        + RESULT_SUPPLEMENTAL_FIELDS.length);
  });

  it('hashes exactly RESULT_DIGEST_BOUND_FIELDS and derives the source identity', () => {
    const projection = resultDigestProjection(
      {
        checkpointId: 'checkpoint-x',
        checkpointDigest: 'b'.repeat(64),
        checkpointSourceWorkerGeneration: 4,
        manifestDigest: MANIFEST_DIGEST,
        // Deliberately contradicts the checkpoint identity: the digest must ignore it.
        segment0WorkerId: 'caller-supplied-attacker',
        inputTokenIds: [1, 2],
        boundaryBytes: 64,
        segment0ExecutionMs: 12.5,
        segment1ExecutionMs: 7.25,
        top1TokenId: 3,
        top1Logit: 1.25,
        logitsShape: [1, 2, 8],
        resumedFromCheckpoint: false,
        artifactCache: { segment1: { allCacheHits: true } },
      },
      { sourceWorkerIdentity: { workerId: 'browser-a' } },
      { workerId: 'browser-b', role: 'segment1', generation: 4, profileProbeHash: 'c'.repeat(64) },
    );

    expect(Object.keys(projection).sort()).toEqual([...RESULT_DIGEST_BOUND_FIELDS].sort());
    expect(projection.segment0WorkerId).toBe('browser-a');
    expect(projection.segment1WorkerIdentity).toMatchObject({ workerId: 'browser-b', role: 'segment1' });
    expect(Object.keys(projection)).not.toContain('artifactCache');
  });

  it('classifies every stored result field exactly once', async () => {
    const { baseUrl } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, 'digest-scope-classification', source.cookie);

    const accepted = await postJson(
      `${baseUrl}/api/runs/digest-scope-classification/result`,
      representativeReport(checkpoint.body),
      consumer.cookie,
    );
    expect(accepted.response.status).toBe(201);

    const stored = await (await fetch(`${baseUrl}/api/runs/digest-scope-classification/result`)).json();
    for (const field of Object.keys(stored)) {
      expect(CLASSIFIED_FIELDS.has(field)).toBe(true);
    }
    // The representative runner report contributes each known field once.
    for (const field of Object.keys(representativeReport(checkpoint.body))) {
      expect(CLASSIFIED_FIELDS.has(field)).toBe(true);
    }
    for (const field of RESULT_DIGEST_BOUND_FIELDS) {
      expect(Object.keys(stored)).toContain(field);
    }
  });

  it('treats an unknown caller field as supplemental (not digest-bound)', async () => {
    const { baseUrl } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, 'digest-scope-unknown-field', source.cookie);
    const base = representativeReport(checkpoint.body);

    const first = await postJson(
      `${baseUrl}/api/runs/digest-scope-unknown-field/result`,
      { ...base, futureTelemetry: { note: 'first' } },
      consumer.cookie,
    );
    expect(first.response.status).toBe(201);
    expect(CLASSIFIED_FIELDS.has('futureTelemetry')).toBe(false);

    const retry = await postJson(
      `${baseUrl}/api/runs/digest-scope-unknown-field/result`,
      { ...base, futureTelemetry: { note: 'changed' } },
      consumer.cookie,
    );
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({ idempotent: true, resultDigest: first.body.resultDigest });
  });

  it('is idempotent when a retry differs only in supplemental fields and keeps the first record', async () => {
    const { baseUrl } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, 'digest-scope-supplemental-retry', source.cookie);

    const first = await postJson(
      `${baseUrl}/api/runs/digest-scope-supplemental-retry/result`,
      representativeReport(checkpoint.body),
      consumer.cookie,
    );
    expect(first.response.status).toBe(201);

    const before = await (await fetch(`${baseUrl}/api/runs/digest-scope-supplemental-retry/result`)).json();

    const retry = await postJson(
      `${baseUrl}/api/runs/digest-scope-supplemental-retry/result`,
      {
        ...representativeReport(checkpoint.body),
        artifactCache: {
          segment0: { allCacheHits: false, budget: { verdict: 'pass' } },
          segment1: { allCacheHits: false, budget: { verdict: 'pass' } },
        },
        adapter: { vendor: 'vulkan', architecture: 'other', isFallbackAdapter: true },
        artifactLayout: 'per-segment-external-data',
        segmentExternalData: [{ path: 'segment-0.onnx.data', byteLength: 999 }],
        schemaVersion: '2.0.0',
      },
      consumer.cookie,
    );
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({ idempotent: true, resultDigest: first.body.resultDigest });

    const after = await (await fetch(`${baseUrl}/api/runs/digest-scope-supplemental-retry/result`)).json();
    expect(after).toEqual(before);
  });

  it.each([
    ['segment1ExecutionMs', { segment1ExecutionMs: 8.5 }],
    ['top1Logit', { top1Logit: 2.5 }],
    ['top1TokenId', { top1TokenId: 4 }],
    ['tokenText', { tokenText: 'changed' }],
    ['logitsShape', { logitsShape: [1, 2, 16] }],
  ])('rejects a retry that changes the digest-bound field %s', async (label, override) => {
    const { baseUrl } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const runId = `digest-scope-conflict-${label}`;
    const checkpoint = await createCheckpoint(baseUrl, runId, source.cookie);

    const first = await postJson(
      `${baseUrl}/api/runs/${runId}/result`,
      representativeReport(checkpoint.body),
      consumer.cookie,
    );
    expect(first.response.status).toBe(201);

    const conflict = await postJson(
      `${baseUrl}/api/runs/${runId}/result`,
      { ...representativeReport(checkpoint.body), ...override },
      consumer.cookie,
    );
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: 'run-result-conflict', reason: 'completed-run-is-immutable' });
    expect(conflict.body.existingResultDigest).toBe(first.body.resultDigest);

    const stored = await (await fetch(`${baseUrl}/api/runs/${runId}/result`)).json();
    expect(stored.resultDigest).toBe(first.body.resultDigest);
  });

  it('does not claim that resultDigest is a digest of the whole stored record', async () => {
    const { baseUrl } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, 'digest-scope-full-record', source.cookie);

    const accepted = await postJson(
      `${baseUrl}/api/runs/digest-scope-full-record/result`,
      representativeReport(checkpoint.body),
      consumer.cookie,
    );
    expect(accepted.response.status).toBe(201);

    const stored = await (await fetch(`${baseUrl}/api/runs/digest-scope-full-record/result`)).json();
    expect(stored.resultDigest).toBe(accepted.body.resultDigest);
    // A full-record hash is a different, larger surface than the core-result digest.
    expect(sha256Json(stored)).not.toBe(stored.resultDigest);
    expect(stored.resultDigest).toBe(sha256Json(resultDigestProjection({
      ...stored,
      segment0WorkerId: undefined,
    }, { sourceWorkerIdentity: { workerId: stored.segment0WorkerId } }, stored.segment1WorkerIdentity)));
  });
});
