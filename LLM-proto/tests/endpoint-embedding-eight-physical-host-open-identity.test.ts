import { lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
});

describe('8-physical host preflight open identity', () => {
  it('rejects and closes a descriptor whose identity differs from the pre-open lstat', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-host-preflight-open-'));
    const root = join(workspace, 'root');
    const manifest = join(root, 'manifest.json');
    const outside = join(workspace, 'outside.json');
    let redirectedHandle: Awaited<ReturnType<typeof open>> | undefined;
    let closeCalls = 0;

    try {
      await mkdir(root, { recursive: true });
      await writeFile(manifest, '{"status":"pass"}\n', 'utf8');
      await writeFile(outside, '{"status":"outside"}\n', 'utf8');
      const expectedStat = await lstat(manifest);

      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.resetModules();
      vi.doMock('node:fs/promises', () => ({
        ...actual,
        lstat: vi.fn(async (path: any) => (
          String(path) === manifest ? expectedStat : actual.lstat(path)
        )),
        open: vi.fn(async (path: any, flags: any) => {
          if (String(path) !== manifest) return actual.open(path, flags);
          redirectedHandle = await actual.open(outside, 'r');
          return {
            stat: redirectedHandle.stat.bind(redirectedHandle),
            close: async () => {
              closeCalls += 1;
              await redirectedHandle?.close();
            },
          };
        }),
      }));

      const { readRegularJsonFile } = await import(
        '../tools/preflight_endpoint_embedding_eight_physical_bundle.mjs'
      );
      await expect(readRegularJsonFile(manifest)).rejects.toThrow(/changed before open/);
      expect(closeCalls).toBe(1);
    } finally {
      if (redirectedHandle) await redirectedHandle.close().catch(() => {});
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
