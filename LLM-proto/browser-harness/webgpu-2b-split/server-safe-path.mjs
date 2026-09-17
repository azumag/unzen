import { realpath, stat } from 'node:fs/promises';
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

export async function resolveExistingFileWithinRoot(root, relativePath) {
  const lexicalPath = safePath(root, relativePath);
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(root),
    realpath(lexicalPath),
  ]);
  assertPathWithinRoot(nodePath, canonicalRoot, canonicalPath);

  const info = await stat(canonicalPath);
  if (!info.isFile()) throw new Error('not a file');
  return { path: canonicalPath, info };
}
