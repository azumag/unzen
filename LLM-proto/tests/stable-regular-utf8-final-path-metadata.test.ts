import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
});

describe('stable regular UTF-8 final pathname metadata binding', () => {
  it('rejects same-inode metadata drift after descriptor validation and closes the fd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-stable-final-path-'));
    const path = join(dir, 'evidence.json');
    let pathLstatCalls = 0;
    let closeCalls = 0;

    try {
      writeFileSync(path, '{"status":"pass"}\n');
      const initialStat = lstatSync(path, { bigint: true });
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

      vi.resetModules();
      vi.doMock('node:fs', () => ({
        ...actual,
        lstatSync: vi.fn((target: any, options?: any) => {
          if (String(target) !== path) return actual.lstatSync(target, options);
          pathLstatCalls += 1;
          if (pathLstatCalls === 1) return initialStat;
          return {
            dev: initialStat.dev,
            ino: initialStat.ino,
            size: initialStat.size,
            mtimeMs: initialStat.mtimeMs + 1n,
            ctimeMs: initialStat.ctimeMs,
            isSymbolicLink: () => false,
            isFile: () => true,
          };
        }),
        closeSync: vi.fn((fd: number) => {
          closeCalls += 1;
          return actual.closeSync(fd);
        }),
      }));

      const { readStableRegularUtf8File } = await import(
        '../tools/read_stable_regular_utf8_file.mjs'
      );
      expect(() => readStableRegularUtf8File(path, 'test evidence')).toThrow(
        /test evidence path identity changed while reading/,
      );
      expect(pathLstatCalls).toBe(2);
      expect(closeCalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
