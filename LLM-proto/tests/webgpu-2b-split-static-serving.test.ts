import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSplitHarnessServer } from '../browser-harness/webgpu-2b-split/serve.mjs';

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeModelsDir(): Promise<string> {
  const modelsDir = await mkdtemp(join(tmpdir(), 'unzen-models-'));
  tempDirs.push(modelsDir);
  await writeFile(join(modelsDir, 'segment.bin'), 'artifact-bytes');
  return modelsDir;
}

async function startServer(options: {
  modelsDir: string;
  readFileFn?: (path: string) => Promise<Buffer>;
}): Promise<string> {
  const { server } = createSplitHarnessServer(options);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('WebGPU split harness static serving', () => {
  it('preserves the model cache policy after /models/ path remapping', async () => {
    const baseUrl = await startServer({ modelsDir: await makeModelsDir() });

    const response = await fetch(`${baseUrl}/models/segment.bin`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await response.text()).toBe('artifact-bytes');
  });

  it('does not read model artifact content for HEAD', async () => {
    const modelsDir = await makeModelsDir();
    let readCount = 0;
    const baseUrl = await startServer({
      modelsDir,
      readFileFn: async () => {
        readCount += 1;
        throw new Error('HEAD must not read the artifact body');
      },
    });

    const response = await fetch(`${baseUrl}/models/segment.bin`, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await response.text()).toBe('');
    expect(readCount).toBe(0);
  });

  it('keeps ordinary harness assets no-store', async () => {
    const baseUrl = await startServer({ modelsDir: await makeModelsDir() });

    const response = await fetch(`${baseUrl}/index.html`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns a plain 404 for a missing static file', async () => {
    const baseUrl = await startServer({ modelsDir: await makeModelsDir() });

    const response = await fetch(`${baseUrl}/missing-static-file.js`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('application/json');
    expect(await response.text()).toBe('not found');
  });
});
