#!/usr/bin/env node
/** Read a UTF-8 file from one stable regular-file snapshot without following a final symlink. */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

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

export function readStableRegularUtf8File(filePath, label = 'evidence file') {
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

    const text = readFileSync(fd, 'utf8');
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
