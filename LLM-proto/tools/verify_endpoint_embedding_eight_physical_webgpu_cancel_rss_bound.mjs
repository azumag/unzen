#!/usr/bin/env node
/** Read-only verifier for the provenance-bound 8-physical cancellation RSS sidecar. */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBoundCancellationRssEvidence,
  canonicalJsonSha256,
} from './capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';
import { readStableCancellationRssEvidence } from './verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function snapshot(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameSnapshot(a, b) {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.size === b.size
    && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs;
}

export function readStableBoundJsonFile(path, label = 'JSON input', { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) {
    throw new Error('maxBytes must be an integer in 1..268435456');
  }
  const resolved = resolve(path);
  const beforePathStat = lstatSync(resolved, { bigint: true });
  if (!beforePathStat.isFile() || beforePathStat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  if (beforePathStat.size < 1n || beforePathStat.size > BigInt(maxBytes)) {
    throw new Error(`${label} size must be 1..${maxBytes} bytes`);
  }

  const fd = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const beforeFdStat = fstatSync(fd, { bigint: true });
    if (!beforeFdStat.isFile()) throw new Error(`${label} descriptor is not a regular file`);
    if (!sameSnapshot(snapshot(beforePathStat), snapshot(beforeFdStat))) {
      throw new Error(`${label} pathname identity changed before read`);
    }

    const bytes = readFileSync(fd);
    if (bytes.byteLength !== Number(beforeFdStat.size)) {
      throw new Error(`${label} size changed while reading`);
    }

    const afterFdStat = fstatSync(fd, { bigint: true });
    const afterPathStat = lstatSync(resolved, { bigint: true });
    if (!sameSnapshot(snapshot(beforeFdStat), snapshot(afterFdStat))
        || !sameSnapshot(snapshot(beforeFdStat), snapshot(afterPathStat))) {
      throw new Error(`${label} changed while reading`);
    }

    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label} is not valid UTF-8`);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : error}`);
    }
  } finally {
    closeSync(fd);
  }
}

export function validateBoundCancellationRssEvidence(boundEvidence, cancellationEvidence, preflightReport) {
  requireObject(boundEvidence, 'bound evidence');
  const expected = buildBoundCancellationRssEvidence(cancellationEvidence, preflightReport);
  const actualDigest = canonicalJsonSha256(boundEvidence);
  const expectedDigest = canonicalJsonSha256(expected);
  if (actualDigest !== expectedDigest) {
    throw new Error('bound cancellation RSS evidence does not exactly match validated source documents');
  }
  return boundEvidence;
}

export function verifyBoundCancellationRssEvidenceFiles({
  boundEvidencePath,
  cancellationEvidencePath,
  preflightReportPath,
}) {
  const boundEvidence = readStableBoundJsonFile(boundEvidencePath, 'bound evidence');
  const preflightReport = readStableBoundJsonFile(preflightReportPath, 'preflight report');
  const cancellationEvidence = readStableCancellationRssEvidence(cancellationEvidencePath);
  return validateBoundCancellationRssEvidence(boundEvidence, cancellationEvidence, preflightReport);
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv.some((value) => !value)) {
    throw new Error(
      'usage: verify_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs '
      + 'BOUND_JSON CANCELLATION_JSON PREFLIGHT_JSON',
    );
  }
  return {
    boundEvidencePath: resolve(argv[0]),
    cancellationEvidencePath: resolve(argv[1]),
    preflightReportPath: resolve(argv[2]),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = verifyBoundCancellationRssEvidenceFiles(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      kind: report.kind,
      targetTile: report.cancellation.targetTile,
      manifestPayloadSetSha256: report.runtimeIdentity.manifestPayloadSetSha256,
      result: 'verified-exact-source-binding',
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
