import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  createSplitHarnessServer,
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

async function registerWorker(
  baseUrl: string,
  workerId: string,
  role: 'segment0' | 'segment1',
) {
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

function resultPayload(
  checkpoint: Record<string, any>,
  overrides: Record<string, unknown> = {},
) {
  return {
    status: 'pass',
    manifestDigest: MANIFEST_DIGEST,
    checkpointId: checkpoint.checkpointId,
    checkpointDigest: checkpoint.checkpointDigest,
    checkpointSourceWorkerGeneration: checkpoint.sourceWorkerGeneration,
    segment1WorkerId: 'browser-b',
    inputTokenIds: [1, 2],
    boundaryBytes: 64,
    segment0ExecutionMs: 12.5,
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

describe('split Coordinator canonical source worker evidence', () => {
  it('stores the checkpoint source worker when the client omits segment0WorkerId', async () => {
    const { baseUrl } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, 'source-canonical-storage', source.cookie);

    const result = await postJson(
      `${baseUrl}/api/runs/source-canonical-storage/result`,
      resultPayload(checkpoint.body),
      consumer.cookie,
    );
    expect(result.response.status).toBe(201);

    const fetched = await fetch(`${baseUrl}/api/runs/source-canonical-storage/result`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      segment0WorkerId: 'browser-a',
      profileIsolationEvidence: {
        sourceWorkerId: 'browser-a',
      },
    });
  });

  it('treats omitted and explicit canonical source IDs as the same immutable result in both retry directions', async () => {
    const { baseUrl } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');

    const omittedFirstCheckpoint = await createCheckpoint(baseUrl, 'source-retry-omitted-first', source.cookie);
    const omittedFirstPayload = resultPayload(omittedFirstCheckpoint.body);
    const omittedFirst = await postJson(
      `${baseUrl}/api/runs/source-retry-omitted-first/result`,
      omittedFirstPayload,
      consumer.cookie,
    );
    expect(omittedFirst.response.status).toBe(201);

    const explicitRetry = await postJson(
      `${baseUrl}/api/runs/source-retry-omitted-first/result`,
      { ...omittedFirstPayload, segment0WorkerId: 'browser-a' },
      consumer.cookie,
    );
    expect(explicitRetry.response.status).toBe(200);
    expect(explicitRetry.body).toMatchObject({
      idempotent: true,
      resultDigest: omittedFirst.body.resultDigest,
    });

    const explicitFirstCheckpoint = await createCheckpoint(baseUrl, 'source-retry-explicit-first', source.cookie);
    const explicitFirstPayload = resultPayload(explicitFirstCheckpoint.body, {
      segment0WorkerId: 'browser-a',
    });
    const explicitFirst = await postJson(
      `${baseUrl}/api/runs/source-retry-explicit-first/result`,
      explicitFirstPayload,
      consumer.cookie,
    );
    expect(explicitFirst.response.status).toBe(201);

    const { segment0WorkerId: _ignored, ...omittedRetryPayload } = explicitFirstPayload;
    const omittedRetry = await postJson(
      `${baseUrl}/api/runs/source-retry-explicit-first/result`,
      omittedRetryPayload,
      consumer.cookie,
    );
    expect(omittedRetry.response.status).toBe(200);
    expect(omittedRetry.body).toMatchObject({
      idempotent: true,
      resultDigest: explicitFirst.body.resultDigest,
    });
  });

  it('still rejects an explicitly contradictory source worker before result mutation', async () => {
    const { baseUrl, state } = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, 'source-mismatch', source.cookie);

    const rejected = await postJson(
      `${baseUrl}/api/runs/source-mismatch/result`,
      resultPayload(checkpoint.body, { segment0WorkerId: 'browser-other' }),
      consumer.cookie,
    );
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toMatchObject({
      error: 'result-source-worker-mismatch',
      sourceWorkerId: 'browser-a',
      reportedSourceWorkerId: 'browser-other',
    });
    expect(state.results.has('source-mismatch')).toBe(false);
  });
});
