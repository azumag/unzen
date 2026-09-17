import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  openExistingFileWithinRoot,
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
