import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openExistingNonSymlinkFile,
  verifyOpenedFileWithinRoot,
} from '../browser-harness/webgpu-2b-split/server-safe-path.mjs';

describe('endpoint diagnostic server ancestor rebind verification', () => {
  it('rejects an opened descriptor when its pathname is rebound through an ancestor symlink', async () => {
    if (process.platform === 'win32') return;

    const workspace = await mkdtemp(join(tmpdir(), 'unzen-ancestor-rebind-'));
    const root = join(workspace, 'root');
    const nested = join(root, 'nested');
    const outside = join(workspace, 'outside');
    const file = join(nested, 'artifact.bin');
    try {
      await mkdir(nested, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(file, 'inside', 'utf8');
      await writeFile(join(outside, 'artifact.bin'), 'outside', 'utf8');

      const canonicalRoot = await realpath(root);
      const canonicalPath = await realpath(file);
      const { handle, info } = await openExistingNonSymlinkFile(canonicalPath);
      try {
        await rename(nested, join(root, 'nested.original'));
        await symlink(outside, nested, 'dir');

        await expect(
          verifyOpenedFileWithinRoot(canonicalRoot, canonicalPath, info),
        ).rejects.toThrow('path escapes root');
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
