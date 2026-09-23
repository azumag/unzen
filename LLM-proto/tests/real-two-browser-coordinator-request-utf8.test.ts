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

function malformedRegistrationBody() {
  return Buffer.concat([
    Buffer.from('{"workerId":"browser-a","role":"segment0","adapter":"', 'utf8'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}', 'utf8'),
  ]);
}

describe('split Coordinator request UTF-8 boundary', () => {
  it('rejects malformed UTF-8 before route-specific state mutation', async () => {
    const { baseUrl, state } = await startServer();

    const response = await fetch(`${baseUrl}/api/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: malformedRegistrationBody(),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'request body is not valid UTF-8',
    });
    expect(state.workers.size).toBe(0);
    expect(state.checkpoints.size).toBe(0);
    expect(state.results.size).toBe(0);
  });

  it('accepts valid non-ASCII UTF-8 JSON without changing route semantics', async () => {
    const { baseUrl, state } = await startServer();

    const response = await fetch(`${baseUrl}/api/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: 'browser-jp',
        role: 'segment0',
        adapter: '日本語アダプター',
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      workerId: 'browser-jp',
      role: 'segment0',
      generation: 1,
    });
    expect(state.workers.get('browser-jp')?.adapter).toBe('日本語アダプター');
  });
});
