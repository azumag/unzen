import { open, realpath, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

function assertPathWithinRoot(pathApi, root, value) {
  const fromRoot = pathApi.relative(root, value);
  if (
    fromRoot === '..'
    || fromRoot.startsWith(`..${pathApi.sep}`)
    || pathApi.isAbsolute(fromRoot)
  ) {
    throw new Error('path escapes root');
  }
}

export function safePathWithPathApi(pathApi, root, relativePath) {
  const value = pathApi.resolve(root, `.${pathApi.normalize(`/${relativePath}`)}`);
  assertPathWithinRoot(pathApi, root, value);
  return value;
}

export function safePath(root, relativePath) {
  return safePathWithPathApi(nodePath, root, relativePath);
}

async function canonicalPathWithinRoot(root, relativePath) {
  const lexicalPath = safePath(root, relativePath);
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(root),
    realpath(lexicalPath),
  ]);
  assertPathWithinRoot(nodePath, canonicalRoot, canonicalPath);
  return canonicalPath;
}

export async function resolveExistingFileWithinRoot(root, relativePath) {
  const path = await canonicalPathWithinRoot(root, relativePath);
  const info = await stat(path);
  if (!info.isFile()) throw new Error('not a file');
  return { path, info };
}

export async function openExistingFileWithinRoot(root, relativePath) {
  const path = await canonicalPathWithinRoot(root, relativePath);
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a file');
    const stream = handle.createReadStream({ autoClose: true });
    return { path, info, stream };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
