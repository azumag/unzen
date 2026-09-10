#!/usr/bin/env node
/** Read-only verifier for the provenance-bound 8-physical cancellation RSS sidecar. */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBoundCancellationRssEvidence,
  canonicalJsonSha256,
} from './capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';
import { readRegularJsonFile } from './preflight_endpoint_embedding_eight_physical_bundle.mjs';
import { readStableCancellationRssEvidence } from './verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs';

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
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

export async function verifyBoundCancellationRssEvidenceFiles({
  boundEvidencePath,
  cancellationEvidencePath,
  preflightReportPath,
}) {
  const [boundEvidence, preflightReport] = await Promise.all([
    readRegularJsonFile(boundEvidencePath),
    readRegularJsonFile(preflightReportPath),
  ]);
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
  verifyBoundCancellationRssEvidenceFiles(parseArgs(process.argv.slice(2))).then((report) => {
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      kind: report.kind,
      targetTile: report.cancellation.targetTile,
      manifestPayloadSetSha256: report.runtimeIdentity.manifestPayloadSetSha256,
      result: 'verified-exact-source-binding',
    }, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
