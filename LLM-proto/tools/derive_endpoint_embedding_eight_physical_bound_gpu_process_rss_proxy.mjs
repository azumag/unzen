#!/usr/bin/env node
/** Derive the cancellation GPU-process RSS proxy while preserving exact preflight provenance. */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonSha256 } from './capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';
import { deriveGpuProcessRssProxy } from './derive_endpoint_embedding_eight_physical_gpu_process_rss_proxy.mjs';
import { readStableCancellationRssEvidence } from './verify_endpoint_embedding_eight_physical_webgpu_cancel_rss.mjs';
import {
  readStableBoundJsonFile,
  validateBoundCancellationRssEvidence,
} from './verify_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';

export function deriveBoundGpuProcessRssProxy(cancellationEvidence, boundEvidence, preflightReport) {
  const bound = validateBoundCancellationRssEvidence(
    boundEvidence,
    cancellationEvidence,
    preflightReport,
  );
  const proxy = deriveGpuProcessRssProxy(cancellationEvidence);
  return {
    ...proxy,
    schemaVersion: '1.1.0',
    kind: 'unzen-endpoint-embedding-eight-physical-webgpu-preflight-bound-gpu-process-rss-proxy',
    evidenceLevel: 'derived-os-gpu-process-rss-proxy+validated-preflight-bundle-identity',
    sourceEvidence: {
      ...proxy.sourceEvidence,
      boundEvidenceCanonicalSha256: canonicalJsonSha256(bound),
      runtimeIdentity: bound.runtimeIdentity,
    },
    conclusion: (
      'The trusted cancellation capture contains a single Chrome gpu-process role at every selected '
      + 'observation point, and the derived proxy is bound to the exact validated preflight snapshot '
      + 'recorded by the provenance sidecar. This remains supporting diagnostic evidence only.'
    ),
    limitations: [
      ...proxy.limitations,
      'The preserved runtimeIdentity is preflight-declared provenance; payloads after the cancellation target are not claimed as runtime-loaded or runtime-verified by the cancelled browser run.',
    ],
  };
}

function main(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv.some((value) => !value)) {
    throw new Error(
      'usage: derive_endpoint_embedding_eight_physical_bound_gpu_process_rss_proxy.mjs '
      + 'CANCELLATION_JSON BOUND_JSON PREFLIGHT_JSON',
    );
  }
  const cancellationEvidence = readStableCancellationRssEvidence(resolve(argv[0]));
  const boundEvidence = readStableBoundJsonFile(resolve(argv[1]), 'bound evidence');
  const preflightReport = readStableBoundJsonFile(resolve(argv[2]), 'preflight report');
  return deriveBoundGpuProcessRssProxy(cancellationEvidence, boundEvidence, preflightReport);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
