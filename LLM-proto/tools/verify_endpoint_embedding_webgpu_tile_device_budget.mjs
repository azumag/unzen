#!/usr/bin/env node
/** Verify that captured WebGPU adapter limits cover the pinned endpoint embedding execution tiles. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_EMBEDDING_WEBGPU_EXPECTED } from '../browser-harness/endpoint-embedding-tiled-webgpu/contract.js';
import { validateCapturedEndpointEmbeddingRuntimeEvidence } from './capture_endpoint_embedding_webgpu_runtime.mjs';
import { readStableRegularUtf8File } from './read_stable_regular_utf8_file.mjs';

const EXPECTED = ENDPOINT_EMBEDDING_WEBGPU_EXPECTED;
const REQUIRED_LIMIT_FIELDS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
];

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function maximumBytes(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must not be empty`);
  return Math.max(...values.map((value, index) => requirePositiveSafeInteger(value, `${label}[${index}]`)));
}

export function evaluateEndpointEmbeddingWebGpuTileDeviceBudget(adapterLimits) {
  if (!adapterLimits || typeof adapterLimits !== 'object' || Array.isArray(adapterLimits)) {
    throw new Error('adapterLimits must be an object');
  }

  const maximumExecutionTileBytes = maximumBytes(
    EXPECTED.tiles.map((tile) => tile.byteLength),
    'execution tile byte lengths',
  );
  const maximumPhysicalArtifactBytes = maximumBytes(
    EXPECTED.physicalArtifacts.map((artifact) => artifact.bytes),
    'physical artifact byte lengths',
  );

  const checks = Object.fromEntries(REQUIRED_LIMIT_FIELDS.map((field) => {
    const availableBytes = requirePositiveSafeInteger(adapterLimits[field], `adapterLimits.${field}`);
    const headroomBytes = availableBytes - maximumExecutionTileBytes;
    return [field, {
      availableBytes,
      requiredBytes: maximumExecutionTileBytes,
      headroomBytes,
      pass: headroomBytes >= 0,
    }];
  }));
  const status = REQUIRED_LIMIT_FIELDS.every((field) => checks[field].pass) ? 'pass' : 'fail';

  return {
    status,
    decisionStatus: 'diagnostic-only',
    kind: 'unzen-endpoint-embedding-webgpu-tile-device-budget',
    schemaVersion: '1.0.0',
    physicalArtifactCount: EXPECTED.physicalArtifactCount,
    executionTileCount: EXPECTED.executionTileCount,
    maximumPhysicalArtifactBytes,
    maximumExecutionTileBytes,
    checks,
    conclusion: status === 'pass'
      ? 'The captured adapter reports maxBufferSize and maxStorageBufferBindingSize at least as large as every pinned execution tile. This is a necessary device-limit check only; it does not prove ORT GPU-device limit negotiation, allocation success, peak memory, or production suitability.'
      : 'The captured adapter reports a maxBufferSize or maxStorageBufferBindingSize below the largest pinned execution tile. Treat this capture/device profile as incompatible with the pinned tile geometry until the mismatch is explained.',
  };
}

export function verifyCapturedEndpointEmbeddingWebGpuTileDeviceBudgetFile(evidencePath) {
  const { text } = readStableRegularUtf8File(evidencePath, 'captured endpoint embedding evidence');
  const evidence = JSON.parse(text);
  validateCapturedEndpointEmbeddingRuntimeEvidence(evidence);
  const analysis = evaluateEndpointEmbeddingWebGpuTileDeviceBudget(evidence.adapterLimits);
  if (analysis.status !== 'pass') {
    throw new Error('captured WebGPU adapter limits do not cover the pinned endpoint embedding execution tile budget');
  }
  return {
    ...analysis,
    evidence: {
      evidenceLevel: evidence.evidenceLevel,
      capturedAtUtc: evidence.capturedAtUtc,
      userAgent: evidence.userAgent,
      adapterInfo: evidence.adapterInfo,
      adapterLimits: evidence.adapterLimits,
    },
  };
}

function main(argv) {
  if (argv.length !== 1) {
    throw new Error('usage: verify_endpoint_embedding_webgpu_tile_device_budget.mjs EVIDENCE_JSON');
  }
  process.stdout.write(`${JSON.stringify(verifyCapturedEndpointEmbeddingWebGpuTileDeviceBudgetFile(argv[0]), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
