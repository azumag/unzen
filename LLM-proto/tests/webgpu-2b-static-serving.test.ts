import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWebgpu2bStaticResponse } from '../browser-harness/webgpu-2b/static-serving.mjs';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeRoots() {
  const workspace = await mkdtemp(join(tmpdir(), 'unzen-webgpu-2b-static-'));
  tempDirs.push(workspace);
  const root = join(workspace, 'harness');
  const modelsDir = join(workspace, 'models');
  await writeFile(join(workspace, 'placeholder'), '');
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(join(modelsDir, 'repo'), { recursive: true }),
  ]));
  await writeFile(join(root, 'index.html'), '<html>ok</html>');
  await writeFile(join(modelsDir, 'repo', 'model.bin'), 'artifact-bytes');
  return { root, modelsDir };
}

describe('legacy WebGPU 2B static serving', () => {
  it('keeps local model artifacts cacheable after /models/ remapping', async () => {
    const { root, modelsDir } = await makeRoots();

    const response = await resolveWebgpu2bStaticResponse({
      method: 'GET',
      rawPathname: '/models/repo/model.bin',
      root,
      modelsDir,
    });

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('public, max-age=3600');
    expect(Buffer.from(response.body as Buffer).toString('utf8')).toBe('artifact-bytes');
  });

  it('does not read a local model artifact body for HEAD', async () => {
    const { root, modelsDir } = await makeRoots();
    let readCount = 0;

    const response = await resolveWebgpu2bStaticResponse({
      method: 'HEAD',
      rawPathname: '/models/repo/model.bin',
      root,
      modelsDir,
      readFileFn: async () => {
        readCount += 1;
        throw new Error('HEAD must not read model bytes');
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('public, max-age=3600');
    expect(response.body).toBeUndefined();
    expect(readCount).toBe(0);
  });

  it('keeps ordinary harness assets no-store', async () => {
    const { root, modelsDir } = await makeRoots();

    const response = await resolveWebgpu2bStaticResponse({
      method: 'GET',
      rawPathname: '/index.html',
      root,
      modelsDir,
    });

    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
  });

  it('returns a plain 404 for a missing local model artifact', async () => {
    const { root, modelsDir } = await makeRoots();

    const response = await resolveWebgpu2bStaticResponse({
      method: 'GET',
      rawPathname: '/models/repo/missing.bin',
      root,
      modelsDir,
    });

    expect(response).toEqual({ status: 404, headers: {}, body: 'not found' });
  });
});
