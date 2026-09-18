import { appendFile, mkdtemp, mkdir, rename, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  openExistingFileWithinRoot,
  openExistingNonSymlinkFile,
  readBoundedUtf8FileHandle,
  resolveExistingFileWithinRoot,
  safePathWithPathApi,
} from '../browser-harness/webgpu-2b-split/server-safe-path.mjs';

async function readUtf8Stream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('endpoint diagnostic server path containment', () => {
  it('accepts nested files with POSIX separators', () => {
    expect(safePathWithPathApi(posix, '/repo/root', 'nested/file.js')).toBe('/repo/root/nested/file.js');
  });

  it('accepts nested files with Windows separators', () => {
    expect(safePathWithPathApi(win32, 'C:\\repo\\root', 'nested/file.js')).toBe(
      'C:\\repo\\root\\nested\\file.js',
    );
  });

  it('keeps parent traversal rooted under the static root', () => {
    expect(safePathWithPathApi(posix, '/repo/root', '../outside.js')).toBe('/repo/root/outside.js');
    expect(safePathWithPathApi(win32, 'C:\\repo\\root', '..\\outside.js')).toBe(
      'C:\\repo\\root\\outside.js',
    );
  });

  it('rejects a Windows drive-qualified component that path.relative treats as absolute', () => {
    expect(() => safePathWithPathApi(win32, 'C:\\repo\\root', 'C:\\outside.js')).toThrow(
      'path escapes root',
    );
  });

  it('resolves a regular file only after confirming its canonical target stays under the root', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const root = join(workspace, 'root');
    try {
      await mkdir(join(root, 'nested'), { recursive: true });
      await writeFile(join(root, 'nested', 'file.js'), 'export const ok = true;\n', 'utf8');

      const resolved = await resolveExistingFileWithinRoot(root, 'nested/file.js');
      expect(resolved.path).toBe(join(root, 'nested', 'file.js'));
      expect(resolved.info.isFile()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('opens a direct regular file through the descriptor-bound exact-path helper', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const file = join(workspace, 'report.json');
    try {
      await writeFile(file, '{"status":"pass"}\n', 'utf8');
      const { handle, info } = await openExistingNonSymlinkFile(file);
      try {
        expect(info.isFile()).toBe(true);
        expect(await handle.readFile('utf8')).toBe('{"status":"pass"}\n');
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reads descriptor-bound UTF-8 text without exceeding the configured byte ceiling', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const file = join(workspace, 'report.json');
    try {
      await writeFile(file, '{"ok":1}\n', 'utf8');
      const { handle, info } = await openExistingNonSymlinkFile(file);
      try {
        await expect(readBoundedUtf8FileHandle(handle, info, {
          maxBytes: info.size,
          field: 'report',
          chunkBytes: 3,
        })).resolves.toBe('{"ok":1}\n');
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('preserves valid multibyte UTF-8 text', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const file = join(workspace, 'report.json');
    const text = '{"message":"雪"}\n';
    try {
      await writeFile(file, text, 'utf8');
      const { handle, info } = await openExistingNonSymlinkFile(file);
      try {
        await expect(readBoundedUtf8FileHandle(handle, info, {
          maxBytes: info.size,
          field: 'report',
          chunkBytes: 2,
        })).resolves.toBe(text);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects malformed UTF-8 instead of replacement-decoding descriptor bytes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const file = join(workspace, 'report.json');
    try {
      await writeFile(file, Buffer.from([
        0x7b, 0x22, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x22, 0x3a, 0x22,
        0xc3, 0x28,
        0x22, 0x7d,
      ]));
      const { handle, info } = await openExistingNonSymlinkFile(file);
      try {
        await expect(readBoundedUtf8FileHandle(handle, info, {
          maxBytes: info.size,
          field: 'report',
          chunkBytes: 3,
        })).rejects.toThrow('report is not valid UTF-8');
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('returns an empty string for a stable zero-length descriptor-bound file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const file = join(workspace, 'empty.txt');
    try {
      await writeFile(file, '', 'utf8');
      const { handle, info } = await openExistingNonSymlinkFile(file);
      try {
        await expect(readBoundedUtf8FileHandle(handle, info, {
          maxBytes: 0,
          field: 'empty',
        })).resolves.toBe('');
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects an already oversized descriptor-bound text file before reading it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const file = join(workspace, 'report.json');
    try {
      await writeFile(file, '123456789', 'utf8');
      const { handle, info } = await openExistingNonSymlinkFile(file);
      try {
        await expect(readBoundedUtf8FileHandle(handle, info, {
          maxBytes: 8,
          field: 'report',
        })).rejects.toThrow('report exceeds 8 bytes');
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects descriptor-bound text that grows past the ceiling after open', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const file = join(workspace, 'report.json');
    try {
      await writeFile(file, '12345678', 'utf8');
      const { handle, info } = await openExistingNonSymlinkFile(file);
      try {
        await appendFile(file, '9', 'utf8');
        await expect(readBoundedUtf8FileHandle(handle, info, {
          maxBytes: 8,
          field: 'report',
          chunkBytes: 8,
        })).rejects.toThrow('report exceeds 8 bytes');
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects descriptor-bound text that shrinks after open', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const file = join(workspace, 'report.json');
    try {
      await writeFile(file, '12345678', 'utf8');
      const { handle, info } = await openExistingNonSymlinkFile(file);
      try {
        await truncate(file, 4);
        await expect(readBoundedUtf8FileHandle(handle, info, {
          maxBytes: 8,
          field: 'report',
          chunkBytes: 3,
        })).rejects.toThrow('report changed while reading');
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects same-size in-place mutation after the descriptor metadata snapshot', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const file = join(workspace, 'report.json');
    try {
      await writeFile(file, '12345678', 'utf8');
      const { handle, info } = await openExistingNonSymlinkFile(file);
      try {
        await writeFile(file, 'ABCDEFGH', 'utf8');
        await utimes(file, new Date(0), new Date(0));
        await expect(readBoundedUtf8FileHandle(handle, info, {
          maxBytes: 8,
          field: 'report',
          chunkBytes: 3,
        })).rejects.toThrow('report changed while reading');
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects a direct symlink through the exact-path helper', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const target = join(workspace, 'target.json');
    const alias = join(workspace, 'alias.json');
    try {
      await writeFile(target, '{}\n', 'utf8');
      try {
        await symlink(target, alias, 'file');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return;
        throw error;
      }
      await expect(openExistingNonSymlinkFile(alias)).rejects.toThrow('symbolic link');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects an intermediate directory symlink whose canonical target escapes the root', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const root = join(workspace, 'root');
    const outside = join(workspace, 'outside');
    try {
      await mkdir(root, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'secret.bin'), 'outside', 'utf8');

      try {
        await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return;
        throw error;
      }

      await expect(openExistingFileWithinRoot(root, 'escape/secret.bin')).rejects.toThrow(
        'path escapes root',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('keeps the response stream bound to the file that was opened before a pathname replacement', async () => {
    if (process.platform === 'win32') return;

    const workspace = await mkdtemp(join(tmpdir(), 'unzen-safe-path-'));
    const root = join(workspace, 'root');
    const file = join(root, 'artifact.bin');
    try {
      await mkdir(root, { recursive: true });
      await writeFile(file, 'original-bytes', 'utf8');

      const opened = await openExistingFileWithinRoot(root, 'artifact.bin');
      await rename(file, join(root, 'artifact.original.bin'));
      await writeFile(file, 'replacement-bytes', 'utf8');

      expect(await readUtf8Stream(opened.stream)).toBe('original-bytes');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
