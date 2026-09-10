#!/usr/bin/env node
/** Read-only verifier for the provenance-bound 8-physical normal RSS sidecar. */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBoundNormalRssEvidence,
} from './capture_endpoint_embedding_eight_physical_webgpu_process_rss_bound.mjs';
import { canonicalJsonSha256 } from './capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';
import { readStableBoundJsonFile } from './verify_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';
import { readStableProcessRssEvidence } from './verify_endpoint_embedding_eight_physical_webgpu_process_rss.mjs';

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function validateBoundNormalRssEvidence(boundEvidence, processRssEvidence, preflightReport) {
  requireObject(boundEvidence, 'bound evidence');
  const expected = buildBoundNormalRssEvidence(processRssEvidence, preflightReport);
  if (canonicalJsonSha256(boundEvidence) !== canonicalJsonSha256(expected)) {
    throw new Error('bound normal RSS evidence does not exactly match validated source documents');
  }
  return boundEvidence;
}

export function verifyBoundNormalRssEvidenceFiles({
  boundEvidencePath,
  processRssEvidencePath,
  preflightReportPath,
}) {
  const boundEvidence = readStableBoundJsonFile(boundEvidencePath, 'bound evidence');
  const processRssEvidence = readStableProcessRssEvidence(processRssEvidencePath);
  const preflightReport = readStableBoundJsonFile(preflightReportPath, 'preflight report');
  return validateBoundNormalRssEvidence(boundEvidence, processRssEvidence, preflightReport);
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv.some((value) => !value)) {
    throw new Error(
      'usage: verify_endpoint_embedding_eight_physical_webgpu_process_rss_bound.mjs '
      + 'BOUND_JSON PROCESS_RSS_JSON PREFLIGHT_JSON',
    );
  }
  return {
    boundEvidencePath: resolve(argv[0]),
    processRssEvidencePath: resolve(argv[1]),
    preflightReportPath: resolve(argv[2]),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = verifyBoundNormalRssEvidenceFiles(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      kind: report.kind,
      manifestPayloadSetSha256: report.runtimeIdentity.manifestPayloadSetSha256,
      verifiedPhysicalArtifactCount: report.runtimeVerification.verifiedPhysicalArtifactCount,
      result: 'verified-exact-source-and-runtime-binding',
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
