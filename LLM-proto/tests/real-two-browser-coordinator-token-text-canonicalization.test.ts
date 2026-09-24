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
  const { server } = createSplitHarnessServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
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
    segment0WorkerId: 'browser-a',
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

describe('split Coordinator canonical tokenText evidence', () => {
  it('stores omitted tokenText as null and treats an explicit-null retry as idempotent', async () => {
    const baseUrl = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, 'token-text-omitted-first', source.cookie);
    const payload = resultPayload(checkpoint.body);

    const first = await postJson(
      `${baseUrl}/api/runs/token-text-omitted-first/result`,
      payload,
      consumer.cookie,
    );
    expect(first.response.status).toBe(201);

    const stored = await fetch(`${baseUrl}/api/runs/token-text-omitted-first/result`);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({ tokenText: null });

    const retry = await postJson(
      `${baseUrl}/api/runs/token-text-omitted-first/result`,
      { ...payload, tokenText: null },
      consumer.cookie,
    );
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({
      idempotent: true,
      resultDigest: first.body.resultDigest,
    });
  });

  it('treats explicit null followed by omission as the same immutable result', async () => {
    const baseUrl = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, 'token-text-null-first', source.cookie);
    const explicitNullPayload = resultPayload(checkpoint.body, { tokenText: null });

    const first = await postJson(
      `${baseUrl}/api/runs/token-text-null-first/result`,
      explicitNullPayload,
      consumer.cookie,
    );
    expect(first.response.status).toBe(201);

    const { tokenText: _ignored, ...omittedPayload } = explicitNullPayload;
    const retry = await postJson(
      `${baseUrl}/api/runs/token-text-null-first/result`,
      omittedPayload,
      consumer.cookie,
    );
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({
      idempotent: true,
      resultDigest: first.body.resultDigest,
    });

    const stored = await fetch(`${baseUrl}/api/runs/token-text-null-first/result`);
    expect(await stored.json()).toMatchObject({ tokenText: null });
  });

  it('preserves a non-null tokenText value', async () => {
    const baseUrl = await startServer();
    const source = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const consumer = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, 'token-text-value', source.cookie);

    const result = await postJson(
      `${baseUrl}/api/runs/token-text-value/result`,
      resultPayload(checkpoint.body, { tokenText: 'hello' }),
      consumer.cookie,
    );
    expect(result.response.status).toBe(201);

    const stored = await fetch(`${baseUrl}/api/runs/token-text-value/result`);
    expect(await stored.json()).toMatchObject({ tokenText: 'hello' });
  });
});
