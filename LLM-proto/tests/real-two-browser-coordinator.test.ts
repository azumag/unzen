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

describe('real two-browser split Coordinator harness', () => {
  it('relays exactly two boundary tensors through Coordinator storage', async () => {
    const { baseUrl, state } = await startServer();
    const registerA = await fetch(`${baseUrl}/api/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: 'browser-a', role: 'segment0' }),
    });
    const registerB = await fetch(`${baseUrl}/api/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: 'browser-b', role: 'segment1' }),
    });
    expect(registerA.status).toBe(201);
    expect(registerB.status).toBe(201);

    const tensors = [
      { name: 'boundary-residual', type: 'float32', dims: [1, 2, 4], bytes: 32, base64: 'AAAA' },
      { name: 'boundary-mlp', type: 'float32', dims: [1, 2, 4], bytes: 32, base64: 'BBBB' },
    ];
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

  it('allows a standby browser to consume the same Coordinator checkpoint', async () => {
    const { baseUrl } = await startServer();
    await fetch(`${baseUrl}/api/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: 'browser-a', role: 'segment0' }),
    });
    await fetch(`${baseUrl}/api/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: 'browser-b-standby', role: 'standby' }),
    });
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
    });
  });
});
