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

  it('rejects and closes when the pathname identity changes after the descriptor read', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-host-preflight-post-read-'));
    const root = join(workspace, 'root');
    const manifest = join(root, 'manifest.json');
    const outside = join(workspace, 'outside.json');
    let acceptedHandle: Awaited<ReturnType<typeof open>> | undefined;
    let closeCalls = 0;
    let manifestLstatCalls = 0;

    try {
      await mkdir(root, { recursive: true });
      await writeFile(manifest, '{"status":"pass"}\n', 'utf8');
      await writeFile(outside, '{"status":"outside"}\n', 'utf8');
      const manifestStat = await lstat(manifest);
      const outsideStat = await lstat(outside);

      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.resetModules();
      vi.doMock('node:fs/promises', () => ({
        ...actual,
        lstat: vi.fn(async (path: any) => {
          if (String(path) !== manifest) return actual.lstat(path);
          manifestLstatCalls += 1;
          return manifestLstatCalls === 1 ? manifestStat : outsideStat;
        }),
        open: vi.fn(async (path: any, flags: any) => {
          if (String(path) !== manifest) return actual.open(path, flags);
          acceptedHandle = await actual.open(manifest, flags);
          return {
            stat: acceptedHandle.stat.bind(acceptedHandle),
            read: acceptedHandle.read.bind(acceptedHandle),
            close: async () => {
              closeCalls += 1;
              await acceptedHandle?.close();
            },
          };
        }),
      }));

      const { readRegularJsonFile } = await import(
        '../tools/preflight_endpoint_embedding_eight_physical_bundle.mjs'
      );
      await expect(readRegularJsonFile(manifest)).rejects.toThrow(/path identity changed while reading/);
      expect(manifestLstatCalls).toBe(2);
      expect(closeCalls).toBe(1);
    } finally {
      if (acceptedHandle) await acceptedHandle.close().catch(() => {});
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
