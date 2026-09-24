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
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, state };
}

async function postJson(
  url: string,
  body: unknown,
  cookie?: string,
) {
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
  role: 'segment0' | 'segment1' | 'standby',
) {
  return postJson(`${baseUrl}/api/workers/register`, { workerId, role });
}

async function createCheckpoint(baseUrl: string, cookie: string | undefined) {
  return postJson(`${baseUrl}/api/runs/strict-identities/checkpoint`, {
    sourceWorkerId: 'browser-a',
    manifestDigest: MANIFEST_DIGEST,
    inputTokenIds: [1, 2],
    segmentExecutionMs: 12.5,
    tensors,
  }, cookie);
}

function validResult(
  checkpoint: Record<string, unknown>,
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
    ...overrides,
  };
}

describe('split Coordinator strict JSON worker identity boundary', () => {
  it('rejects coercible registration worker IDs and roles before state mutation', async () => {
    const { baseUrl, state } = await startServer();

    const workerIdCases = [
      ['browser-a'],
      123,
      true,
      { toString: 'browser-a' },
    ];
    for (const workerId of workerIdCases) {
      const rejected = await postJson(`${baseUrl}/api/workers/register`, {
        workerId,
        role: 'segment0',
      });
      expect(rejected.response.status).toBe(400);
      expect(rejected.body).toMatchObject({ error: 'invalid worker id' });
      expect(state.workers.size).toBe(0);
    }

    const roleCases = [['segment0'], 1, true, { value: 'segment0' }];
    for (const role of roleCases) {
      const rejected = await postJson(`${baseUrl}/api/workers/register`, {
        workerId: 'browser-a',
        role,
      });
      expect(rejected.response.status).toBe(400);
      expect(rejected.body).toMatchObject({ error: 'invalid worker role' });
      expect(state.workers.size).toBe(0);
    }
  });

  it('does not let a coercible checkpoint source ID alias a registered worker', async () => {
    const { baseUrl, state } = await startServer();
    const registered = await registerWorker(baseUrl, 'browser-a', 'segment0');
    expect(registered.response.status).toBe(201);

    const rejected = await postJson(`${baseUrl}/api/runs/strict-checkpoint/checkpoint`, {
      sourceWorkerId: ['browser-a'],
      manifestDigest: MANIFEST_DIGEST,
      inputTokenIds: [1, 2],
      segmentExecutionMs: 12.5,
      tensors,
    }, registered.cookie);

    expect(rejected.response.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: 'invalid worker id' });
    expect(state.checkpoints.size).toBe(0);
  });

  it('rejects coercible result worker identities before result evidence is stored', async () => {
    const { baseUrl, state } = await startServer();
    const registeredA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registeredB = await registerWorker(baseUrl, 'browser-b', 'segment1');
    const checkpoint = await createCheckpoint(baseUrl, registeredA.cookie);
    expect(checkpoint.response.status).toBe(201);

    const badConsumer = await postJson(`${baseUrl}/api/runs/strict-identities/result`,
      validResult(checkpoint.body as Record<string, unknown>, {
        segment1WorkerId: ['browser-b'],
      }),
      registeredB.cookie,
    );
    expect(badConsumer.response.status).toBe(400);
    expect(badConsumer.body).toMatchObject({ error: 'invalid worker id' });
    expect(state.results.size).toBe(0);

    const badProducer = await postJson(`${baseUrl}/api/runs/strict-identities/result`,
      validResult(checkpoint.body as Record<string, unknown>, {
        segment0WorkerId: ['browser-a'],
      }),
      registeredB.cookie,
    );
    expect(badProducer.response.status).toBe(409);
    expect(badProducer.body).toMatchObject({
      error: 'result-source-worker-mismatch',
      sourceWorkerId: 'browser-a',
      reportedSourceWorkerId: ['browser-a'],
    });
    expect(state.results.size).toBe(0);
  });
});
