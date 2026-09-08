#!/usr/bin/env node
/** Revalidate a captured endpoint embedding ORT Web/WebGPU evidence JSON file. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateCapturedEndpointEmbeddingRuntimeEvidence } from './capture_endpoint_embedding_webgpu_runtime.mjs';

function main(argv) {
  if (argv.length !== 1) {
    throw new Error('usage: verify_endpoint_embedding_webgpu_runtime_evidence.mjs EVIDENCE_JSON');
  }
  const evidencePath = resolve(argv[0]);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  validateCapturedEndpointEmbeddingRuntimeEvidence(evidence);
  process.stdout.write(`${JSON.stringify({
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
  }, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error);
  process.exit(1);
}
