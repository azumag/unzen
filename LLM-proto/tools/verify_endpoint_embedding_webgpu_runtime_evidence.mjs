#!/usr/bin/env node
/** Revalidate a captured endpoint embedding ORT Web/WebGPU evidence JSON file. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCapturedEndpointEmbeddingRuntimeEvidence } from './capture_endpoint_embedding_webgpu_runtime.mjs';

export function verifyCapturedEndpointEmbeddingEvidenceFile(evidencePath) {
  const resolvedPath = resolve(evidencePath);
  const evidence = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  validateCapturedEndpointEmbeddingRuntimeEvidence(evidence);
  return {
    status: 'pass',
    decisionStatus: evidence.decisionStatus,
    evidenceLevel: evidence.evidenceLevel,
    kind: evidence.kind,
    capturedAtUtc: evidence.capturedAtUtc,
    sourceGraphSha256: evidence.sourceGraphSha256,
    chromeVersion: evidence.captureEnvironment.chromeVersion,
    cdpBrowser: evidence.captureEnvironment.cdpBrowser,
    onnxruntimeWebVersion: evidence.onnxruntimeWebVersion,
    completeEmbeddingComparison: evidence.completeEmbeddingComparison,
    outputShape: evidence.outputShape,
  };
}

function main(argv) {
  if (argv.length !== 1) {
    throw new Error('usage: verify_endpoint_embedding_webgpu_runtime_evidence.mjs EVIDENCE_JSON');
  }
  process.stdout.write(`${JSON.stringify(verifyCapturedEndpointEmbeddingEvidenceFile(argv[0]), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
