#!/usr/bin/env node
/** Verify browser/WebGPU device context preserved in captured endpoint embedding evidence. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateCapturedEndpointEmbeddingRuntimeEvidence,
  validateEndpointEmbeddingWebGpuDeviceContextFields,
} from './capture_endpoint_embedding_webgpu_runtime.mjs';
import { readStableRegularUtf8File } from './read_stable_regular_utf8_file.mjs';

export { validateEndpointEmbeddingWebGpuDeviceContextFields };

export function validateCapturedEndpointEmbeddingWebGpuDeviceContext(evidence) {
  validateCapturedEndpointEmbeddingRuntimeEvidence(evidence);
  return evidence;
}

export function verifyCapturedEndpointEmbeddingWebGpuDeviceContextFile(evidencePath) {
  const { text } = readStableRegularUtf8File(evidencePath, 'captured endpoint embedding evidence');
  const evidence = JSON.parse(text);
  validateCapturedEndpointEmbeddingWebGpuDeviceContext(evidence);
  return {
    status: evidence.status,
    decisionStatus: evidence.decisionStatus,
    evidenceLevel: evidence.evidenceLevel,
    userAgent: evidence.userAgent,
    adapterInfo: evidence.adapterInfo,
    adapterLimits: evidence.adapterLimits,
    captureEnvironment: evidence.captureEnvironment,
  };
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const [evidencePath] = process.argv.slice(2);
  if (!evidencePath) {
    console.error('usage: verify_endpoint_embedding_webgpu_device_context.mjs EVIDENCE_JSON');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(verifyCapturedEndpointEmbeddingWebGpuDeviceContextFile(evidencePath), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
