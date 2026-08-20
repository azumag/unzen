import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  createSplitHarnessServer,
} from '../browser-harness/webgpu-2b-split/serve.mjs';

const servers: import('node:http').Server[] = [];

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

const tensors = [
  { name: 'boundary-residual', type: 'float32', dims: [1, 2, 4], bytes: 32, base64: 'AAAA' },
  { name: 'boundary-mlp', type: 'float32', dims: [1, 2, 4], bytes: 32, base64: 'BBBB' },
];

describe('real two-browser split Coordinator harness', () => {
  it('relays exactly two boundary tensors through Coordinator storage', async () => {
    const { baseUrl, state } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1');
    expect(registerA.response.status).toBe(201);
    expect(registerB.response.status).toBe(201);
    expect(registerA.body.profileProbeHash).not.toBe(registerB.body.profileProbeHash);

    const posted = await fetch(`${baseUrl}/api/runs/run-1/checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceWorkerId: 'browser-a',
        inputTokenIds: [1, 2],
        tensors,
      }),
    });
    expect(posted.status).toBe(201);
    expect(await posted.json()).toMatchObject({
      relayOwner: 'coordinator',
      tensorBytes: 64,
    });

    const fetched = await fetch(`${baseUrl}/api/runs/run-1/checkpoint`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      runId: 'run-1',
      sourceWorkerId: 'browser-a',
      relayOwner: 'coordinator',
      directWorkerNetworking: false,
      tensors,
    });
    expect(state.checkpoints.size).toBe(1);
  });

  it('accepts a result only when segment workers have distinct browser profile probes', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1');
    expect(registerA.cookie).toBeTruthy();
    expect(registerB.cookie).toBeTruthy();
    expect(registerA.body.profileProbeHash).not.toBe(registerB.body.profileProbeHash);

    await fetch(`${baseUrl}/api/runs/profile-ok/checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceWorkerId: 'browser-a', tensors }),
    });

    const result = await fetch(`${baseUrl}/api/runs/profile-ok/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'pass',
        segment1WorkerId: 'browser-b',
      }),
    });
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({
      profileIsolationConfirmed: true,
      profileIsolationEvidence: {
        method: 'coordinator-issued-http-only-cookie',
        confirmed: true,
        sourceWorkerId: 'browser-a',
        segment1WorkerId: 'browser-b',
      },
    });
  });

  it('rejects different worker IDs when both tabs share one browser profile cookie', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    expect(registerA.cookie).toBeTruthy();
    const registerB = await registerWorker(baseUrl, 'browser-b', 'segment1', registerA.cookie);
    expect(registerB.cookie).toBe(registerA.cookie);
    expect(registerB.body.profileProbeHash).toBe(registerA.body.profileProbeHash);

    await fetch(`${baseUrl}/api/runs/profile-same/checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceWorkerId: 'browser-a', tensors }),
    });

    const result = await fetch(`${baseUrl}/api/runs/profile-same/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'pass',
        segment1WorkerId: 'browser-b',
      }),
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      ok: false,
      error: 'profile-isolation-not-proven',
      sourceWorkerId: 'browser-a',
      segment1WorkerId: 'browser-b',
    });
  });

  it('rejects direct worker-to-worker networking and malformed checkpoints', async () => {
    const { baseUrl } = await startServer();
    const direct = await fetch(`${baseUrl}/worker-peer/direct`, { method: 'POST' });
    expect(direct.status).toBe(403);
    expect(await direct.json()).toMatchObject({ rejected: true });

    const malformed = await fetch(`${baseUrl}/api/runs/run-2/checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tensors: [{ name: 'only-one' }] }),
    });
    expect(malformed.status).toBe(400);
  });

  it('allows a standby browser from a distinct profile to consume the same Coordinator checkpoint', async () => {
    const { baseUrl } = await startServer();
    const registerA = await registerWorker(baseUrl, 'browser-a', 'segment0');
    const registerStandby = await registerWorker(baseUrl, 'browser-b-standby', 'standby');
    expect(registerA.body.profileProbeHash).not.toBe(registerStandby.body.profileProbeHash);

    await fetch(`${baseUrl}/api/runs/resume-1/checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceWorkerId: 'browser-a',
        tensors: [
          { name: 'a', bytes: 16, base64: 'AAAA' },
          { name: 'b', bytes: 16, base64: 'BBBB' },
        ],
      }),
    });

    const checkpoint = await fetch(`${baseUrl}/api/runs/resume-1/checkpoint`).then((response) => response.json());
    expect(checkpoint.sourceWorkerId).toBe('browser-a');
    expect(checkpoint.relayOwner).toBe('coordinator');

    const result = await fetch(`${baseUrl}/api/runs/resume-1/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'pass',
        segment1WorkerId: 'browser-b-standby',
        resumedFromCheckpoint: true,
      }),
    });
    expect(result.status).toBe(201);
    expect(await fetch(`${baseUrl}/api/runs/resume-1/result`).then((response) => response.json())).toMatchObject({
      segment1WorkerId: 'browser-b-standby',
      resumedFromCheckpoint: true,
      profileIsolationConfirmed: true,
    });
  });
});
