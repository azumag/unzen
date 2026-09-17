import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
});

describe('endpoint diagnostic canonical open identity', () => {
  it('fails closed and closes the descriptor when open returns a different file identity', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-open-'));
    const root = join(workspace, 'root');
    const outside = join(workspace, 'outside.bin');
    const artifact = join(root, 'artifact.bin');
    let redirectedHandle:
      | Awaited<ReturnType<(typeof import('node:fs/promises'))['open']>>
      | undefined;
    let closeCalls = 0;

    try {
      await mkdir(root, { recursive: true });
      await writeFile(artifact, 'inside-bytes', 'utf8');
      await writeFile(outside, 'outside-bytes', 'utf8');

      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.resetModules();
      vi.doMock('node:fs/promises', () => ({
        ...actual,
        open: vi.fn(async (path: any, flags: any) => {
          if (String(path) !== artifact) return actual.open(path, flags);

          redirectedHandle = await actual.open(outside, 'r');
          return {
            stat: redirectedHandle.stat.bind(redirectedHandle),
            createReadStream: redirectedHandle.createReadStream.bind(redirectedHandle),
            close: async () => {
              closeCalls += 1;
              await redirectedHandle?.close();
            },
          };
        }),
      }));

      const { openExistingFileWithinRoot } = await import(
        '../browser-harness/webgpu-2b-split/server-safe-path.mjs'
      );

      await expect(openExistingFileWithinRoot(root, 'artifact.bin')).rejects.toThrow(
        'file changed before open',
      );
      expect(closeCalls).toBe(1);
    } finally {
      if (redirectedHandle) await redirectedHandle.close().catch(() => {});
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
