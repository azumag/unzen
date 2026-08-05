/**
 * Fixture model manifests for contract tests.
 *
 * Every manifest produced here is marked `source: 'fixture'` and carries a
 * deterministic *synthetic* digest (valid hex format, not a real SHA-256).
 * The production code path (Coordinator) rejects fixture manifests, and the
 * async full validator reports a digest mismatch for them, so a fixture can
 * never pass production-level verification.
 *
 * The 30B / 8-segment / ~2.1GB values are an EXAMPLE for feasibility planning,
 * not measured fact (issue #102): the authoritative geometry comes from the
 * manifest, and this fixture's memory basis is explicitly `budgeted`.
 */

import {
  MODEL_MANIFEST_SCHEMA_VERSION,
  type ModelRuntimeRequirements,
  type SegmentedModelManifest,
  type SegmentArtifact,
} from './model-manifest.js';

export interface FixtureModelManifestOptions {
  readonly modelId?: string;
  readonly modelRevision?: string;
  readonly architecture?: string;
  readonly parameterCount?: number;
  readonly quantization?: string;
  readonly totalLayers?: number;
  readonly totalSegments?: number;
  readonly tokenizer?: string;
  readonly checkpointFormat?: string;
  readonly estimatedMemoryMB?: number;
  readonly runtimeRequirements?: ModelRuntimeRequirements;
}

const DEFAULT_RUNTIME_REQUIREMENTS: ModelRuntimeRequirements = {
  minimumVramMB: 4096,
  supportedQuantization: ['q4'],
  minimumRuntimeVersion: '0.2.57',
  minimumChromeVersion: '130',
};

/** Default fixture mirrors the historical 30B example shape, now as a manifest. */
const DEFAULT_OPTIONS = {
  modelId: 'unzen-30b-q4-8seg-example',
  modelRevision: 'rev-2026-08-01',
  architecture: 'llama',
  parameterCount: 30_000_000_000,
  quantization: 'q4',
  totalLayers: 60,
  totalSegments: 8,
  tokenizer: 'unzen-q4-tokenizer-32k',
  checkpointFormat: 'float16',
  estimatedMemoryMB: 2_125,
};

export function createFixtureModelManifest(
  options: FixtureModelManifestOptions = {},
): SegmentedModelManifest {
  const modelId = options.modelId ?? DEFAULT_OPTIONS.modelId;
  const totalLayers = options.totalLayers ?? DEFAULT_OPTIONS.totalLayers;
  const totalSegments = options.totalSegments ?? DEFAULT_OPTIONS.totalSegments;
  const estimatedMemoryMB = options.estimatedMemoryMB ?? DEFAULT_OPTIONS.estimatedMemoryMB;
  const quantization = options.quantization ?? DEFAULT_OPTIONS.quantization;

  return {
    schemaVersion: MODEL_MANIFEST_SCHEMA_VERSION,
    modelId,
    modelRevision: options.modelRevision ?? DEFAULT_OPTIONS.modelRevision,
    architecture: options.architecture ?? DEFAULT_OPTIONS.architecture,
    parameterCount: options.parameterCount ?? DEFAULT_OPTIONS.parameterCount,
    quantization,
    totalLayers,
    tokenizer: options.tokenizer ?? DEFAULT_OPTIONS.tokenizer,
    segments: buildFixtureSegments(modelId, totalLayers, totalSegments, estimatedMemoryMB),
    checkpointFormat: options.checkpointFormat ?? DEFAULT_OPTIONS.checkpointFormat,
    runtimeRequirements: options.runtimeRequirements ?? DEFAULT_RUNTIME_REQUIREMENTS,
    manifestDigest: syntheticFixtureDigest(modelId),
    source: 'fixture',
  };
}

function buildFixtureSegments(
  modelId: string,
  totalLayers: number,
  totalSegments: number,
  estimatedMemoryMB: number,
): SegmentArtifact[] {
  const layersPerSegment = Math.ceil(totalLayers / totalSegments);
  return Array.from({ length: totalSegments }, (_, index) => {
    const layerStart = index * layersPerSegment;
    const layerEnd = Math.min((index + 1) * layersPerSegment - 1, totalLayers - 1);
    return {
      index,
      layerStart,
      layerEnd,
      byteSize: estimatedMemoryMB * 1024 * 1024,
      sha256: syntheticFixtureDigest(`${modelId}-seg-${index}`),
      contentType: 'application/octet-stream',
      encoding: 'zstd',
      artifactLocator: `https://cdn.unzen.local/models/${modelId}/seg-${index}.bin`,
      estimatedMemoryMB,
      memoryBasis: 'budgeted',
      measurementConditions: 'fixture: synthetic values for contract tests (issue #102)',
      compatibleRuntimes: ['webllm'],
      minimumRuntimeVersion: '0.2.57',
    };
  });
}

/**
 * Deterministic 64-hex digest for fixtures. NOT a real SHA-256: the async full
 * validator intentionally reports a digest mismatch, proving fixtures never
 * reach production verification. Only the digest FORMAT check (shape
 * validation) is satisfied so fixtures can drive test-only Coordinator runs.
 */
function syntheticFixtureDigest(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const chunk = hash.toString(16).padStart(8, '0');
  return `${chunk}${chunk}${chunk}${chunk}${chunk}${chunk}${chunk}${chunk}`;
}
