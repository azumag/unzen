import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
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

function sameFileIdentity(expected, actual) {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

function sameStableReadMetadata(expected, actual) {
  return sameFileIdentity(expected, actual)
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs;
}

function readOnlyNoFollowFlags() {
  return typeof constants.O_NOFOLLOW === 'number'
    ? constants.O_RDONLY | constants.O_NOFOLLOW
    : 'r';
}

async function openRegularFileByIdentity(path) {
  const expectedInfo = await lstat(path);
  if (expectedInfo.isSymbolicLink()) throw new Error('symbolic link');
  if (!expectedInfo.isFile()) throw new Error('not a file');

  const handle = await open(path, readOnlyNoFollowFlags());
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a file');
    if (!sameFileIdentity(expectedInfo, info)) throw new Error('file changed before open');
    return { handle, info };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function readBoundedUtf8FileHandle(
  handle,
  initialInfo,
  { maxBytes, field = 'file', chunkBytes = 64 * 1024 },
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new RangeError('chunkBytes must be a positive safe integer');
  }
  if (initialInfo.size > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} bytes`);
  }

  const data = Buffer.allocUnsafe(initialInfo.size);
  let totalBytes = 0;
  while (totalBytes < initialInfo.size) {
    const readSize = Math.min(chunkBytes, initialInfo.size - totalBytes);
    const { bytesRead } = await handle.read(data, totalBytes, readSize, totalBytes);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
  }

  const growthProbe = Buffer.allocUnsafe(1);
  const { bytesRead: growthBytesRead } = await handle.read(
    growthProbe,
    0,
    growthProbe.byteLength,
    initialInfo.size,
  );
  const finalInfo = await handle.stat();
  if (finalInfo.size > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} bytes`);
  }
  if (
    !sameStableReadMetadata(initialInfo, finalInfo)
    || totalBytes !== initialInfo.size
    || growthBytesRead !== 0
  ) {
    throw new Error(`${field} changed while reading`);
  }
  return data.toString('utf8');
}

export async function resolveExistingFileWithinRoot(root, relativePath) {
  const path = await canonicalPathWithinRoot(root, relativePath);
  const info = await stat(path);
  if (!info.isFile()) throw new Error('not a file');
  return { path, info };
}

export async function openExistingNonSymlinkFile(path) {
  return openRegularFileByIdentity(path);
}

export async function openExistingFileWithinRoot(root, relativePath) {
  const path = await canonicalPathWithinRoot(root, relativePath);
  const { handle, info } = await openRegularFileByIdentity(path);
  try {
    const stream = handle.createReadStream({ autoClose: true });
    return { path, info, stream };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
