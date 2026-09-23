import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
});

function withMetadataDrift(stat: Awaited<ReturnType<typeof lstat>>, field: 'mtimeMs' | 'ctimeMs') {
  return {
    ...stat,
    [field]: stat[field] + 1,
    isSymbolicLink: () => false,
    isFile: () => true,
  };
}

describe('8-physical final pathname metadata binding', () => {
  it('rejects JSON when the same inode changes metadata after the descriptor read', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-final-json-metadata-'));
    const manifest = join(workspace, 'manifest.json');
    let acceptedHandle: Awaited<ReturnType<typeof open>> | undefined;
    let closeCalls = 0;
    let lstatCalls = 0;

    try {
      await writeFile(manifest, '{"status":"pass"}\n', 'utf8');
      const initialStat = await lstat(manifest);
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

      vi.resetModules();
      vi.doMock('node:fs/promises', () => ({
        ...actual,
        lstat: vi.fn(async (path: any) => {
          if (String(path) !== manifest) return actual.lstat(path);
          lstatCalls += 1;
          return lstatCalls === 1 ? initialStat : withMetadataDrift(initialStat, 'mtimeMs');
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
      expect(lstatCalls).toBe(2);
      expect(closeCalls).toBe(1);
    } finally {
      if (acceptedHandle) await acceptedHandle.close().catch(() => {});
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects a hash when the same inode changes metadata after descriptor hashing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-final-hash-metadata-'));
    const payload = join(workspace, 'payload.bin');
    let acceptedHandle: Awaited<ReturnType<typeof open>> | undefined;
    let closeCalls = 0;
    let lstatCalls = 0;

    try {
      await writeFile(payload, Buffer.from('stable-payload'));
      const initialStat = await lstat(payload);
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

      vi.resetModules();
      vi.doMock('node:fs/promises', () => ({
        ...actual,
        lstat: vi.fn(async (path: any) => {
          if (String(path) !== payload) return actual.lstat(path);
          lstatCalls += 1;
          return lstatCalls === 1 ? initialStat : withMetadataDrift(initialStat, 'ctimeMs');
        }),
        open: vi.fn(async (path: any, flags: any) => {
          if (String(path) !== payload) return actual.open(path, flags);
          acceptedHandle = await actual.open(payload, flags);
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

      const { inspectRegularFile } = await import(
        '../tools/preflight_endpoint_embedding_eight_physical_bundle.mjs'
      );
      await expect(inspectRegularFile(payload)).rejects.toThrow(/path identity changed while hashing/);
      expect(lstatCalls).toBe(2);
      expect(closeCalls).toBe(1);
    } finally {
      if (acceptedHandle) await acceptedHandle.close().catch(() => {});
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
