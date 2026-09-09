#!/usr/bin/env node
/** Read a UTF-8 file from one stable regular-file snapshot without following a final symlink. */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

export const DEFAULT_MAX_STABLE_UTF8_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function snapshotIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function requireRegularPathSnapshot(path, label) {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  return snapshotIdentity(stat);
}

function requireMaximumBytes(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('stable UTF-8 file maximumBytes must be a positive safe integer');
  }
  return value;
}

function decodeFatalUtf8(bytes, label) {
  try {
    return FATAL_UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new Error(`${label} must contain valid UTF-8`, { cause: error });
  }
}

function readBoundedUtf8FromFd(fd, label, maximumBytes) {
  const initialSize = fstatSync(fd, { bigint: true }).size;
  if (initialSize > BigInt(maximumBytes)) {
    throw new Error(`${label} exceeds ${maximumBytes} byte limit`);
  }

  const chunks = [];
  let totalBytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maximumBytes));
  while (totalBytes < maximumBytes) {
    const bytesRead = readSync(
      fd,
      buffer,
      0,
      Math.min(buffer.length, maximumBytes - totalBytes),
      null,
    );
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    totalBytes += bytesRead;
  }

  if (totalBytes === maximumBytes) {
    const probe = Buffer.allocUnsafe(1);
    if (readSync(fd, probe, 0, 1, null) !== 0) {
      throw new Error(`${label} exceeds ${maximumBytes} byte limit`);
    }
  }

  return decodeFatalUtf8(Buffer.concat(chunks, totalBytes), label);
}

export function readStableRegularUtf8FileWithReader(filePath, label, readFromFd) {
  if (typeof readFromFd !== 'function') throw new Error('stable file reader callback must be a function');
  const resolvedPath = resolve(filePath);
  const pathBefore = requireRegularPathSnapshot(resolvedPath, label);
  let fd;
  try {
    fd = openSync(resolvedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const fdBeforeStat = fstatSync(fd, { bigint: true });
    if (!fdBeforeStat.isFile()) throw new Error(`${label} must be a regular file`);
    const fdBefore = snapshotIdentity(fdBeforeStat);
    if (!sameFileIdentity(pathBefore, fdBefore)) {
      throw new Error(`${label} path identity changed before opening`);
    }

    const text = readFromFd(fd);
    if (typeof text !== 'string') throw new Error('stable file reader callback must return UTF-8 text');
    const fdAfter = snapshotIdentity(fstatSync(fd, { bigint: true }));
    if (!sameSnapshot(fdBefore, fdAfter)) {
      throw new Error(`${label} changed while reading`);
    }

    const pathAfter = requireRegularPathSnapshot(resolvedPath, label);
    if (!sameFileIdentity(fdAfter, pathAfter)) {
      throw new Error(`${label} path identity changed while reading`);
    }

    return { resolvedPath, text };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readStableRegularUtf8File(
  filePath,
  label = 'evidence file',
  maximumBytes = DEFAULT_MAX_STABLE_UTF8_BYTES,
) {
  const boundedMaximumBytes = requireMaximumBytes(maximumBytes);
  return readStableRegularUtf8FileWithReader(
    filePath,
    label,
    (fd) => readBoundedUtf8FromFd(fd, label, boundedMaximumBytes),
  );
}
