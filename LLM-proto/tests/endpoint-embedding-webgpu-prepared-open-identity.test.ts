import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
});

describe('endpoint embedding prepared-file descriptor binding', () => {
  it('rejects when open returns a different inode than the accepted path snapshot and closes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-prepared-open-identity-'));
    const path = join(dir, 'payload.bin');
    const redirectedPath = join(dir, 'redirected.bin');
    const content = Buffer.from('same pinned bytes');
    let closeCalls = 0;

    try {
      writeFileSync(path, content);
      writeFileSync(redirectedPath, content);
      const actualPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

      vi.resetModules();
      vi.doMock('node:fs/promises', () => ({
        ...actualPromises,
        open: vi.fn(async (target: any, flags: any) => {
          const handle = await actualPromises.open(
            String(target) === path ? redirectedPath : target,
            flags,
          );
          return {
            stat: handle.stat.bind(handle),
            read: handle.read.bind(handle),
            close: async () => {
              closeCalls += 1;
              await handle.close();
            },
          };
        }),
      }));

      const { verifyPreparedFileIdentity } = await import(
        '../tools/preflight_endpoint_embedding_webgpu_capture.mjs'
      );
      await expect(verifyPreparedFileIdentity(path, {
        bytes: content.length,
        sha256: sha256(content),
      }, 'test payload')).rejects.toThrow('test payload changed before hashing');
      expect(closeCalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a pathname rebound after descriptor hashing and closes the accepted descriptor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-prepared-final-path-'));
    const path = join(dir, 'payload.bin');
    const replacementPath = join(dir, 'replacement.bin');
    const content = Buffer.from('pinned prepared bytes');
    let pathLstatCalls = 0;
    let closeCalls = 0;

    try {
      writeFileSync(path, content);
      writeFileSync(replacementPath, content);
      const originalStat = lstatSync(path);
      const replacementStat = lstatSync(replacementPath);
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const actualPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

      vi.resetModules();
      vi.doMock('node:fs', () => ({
        ...actualFs,
        lstatSync: vi.fn((target: any, options?: any) => {
          if (String(target) !== path) return actualFs.lstatSync(target, options);
          pathLstatCalls += 1;
          return pathLstatCalls === 1 ? originalStat : replacementStat;
        }),
      }));
      vi.doMock('node:fs/promises', () => ({
        ...actualPromises,
        open: vi.fn(async (target: any, flags: any) => {
          const handle = await actualPromises.open(target, flags);
          return {
            stat: handle.stat.bind(handle),
            read: handle.read.bind(handle),
            close: async () => {
              closeCalls += 1;
              await handle.close();
            },
          };
        }),
      }));

      const { verifyPreparedFileIdentity } = await import(
        '../tools/preflight_endpoint_embedding_webgpu_capture.mjs'
      );
      await expect(verifyPreparedFileIdentity(path, {
        bytes: content.length,
        sha256: sha256(content),
      }, 'test payload')).rejects.toThrow('test payload path identity changed while hashing');
      expect(pathLstatCalls).toBe(2);
      expect(closeCalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
