/**
 * Runtime validator for SegmentedModelManifest (issue #102).
 *
 * Two entry points:
 * - `validateModelManifestShape` - synchronous structural fail-fast checks used
 *   by the Coordinator constructor at startup.
 * - `validateModelManifest` - async full verification that also recomputes the
 *   manifest digest and verifies an optional signature.
 *
 * Placeholder artifact hashes (`sha256:segment-...`, non-hex values) are
 * REJECTED so a config whose real artifact digests do not match can never
 * generate an execution plan.
 */

import {
  MODEL_MANIFEST_SCHEMA_VERSION,
  computeModelManifestDigest,
  parseQuantizationBits,
  verifyModelManifestSignature,
  type ModelManifestSource,
  type SegmentedModelManifest,
} from './model-manifest.js';

export type ModelManifestValidationStatus = 'valid' | 'invalid';

export type ModelManifestValidationIssueCode =
  | 'invalid-manifest'
  | 'unsupported-schema-version'
  | 'fixture-manifest-not-allowed'
  | 'invalid-model-metadata'
  | 'invalid-quantization'
  | 'unsupported-quantization'
  | 'invalid-runtime-requirements'
  | 'empty-segments'
  | 'duplicate-segment-index'
  | 'missing-segment-index'
  | 'invalid-layer-range'
  | 'non-contiguous-layer-ranges'
  | 'layers-outside-model'
  | 'segments-incomplete'
  | 'invalid-artifact-byte-size'
  | 'placeholder-artifact-digest'
  | 'invalid-artifact-digest'
  | 'invalid-artifact-content-type'
  | 'invalid-artifact-locator'
  | 'invalid-artifact-memory'
  | 'invalid-memory-basis'
  | 'invalid-compatible-runtimes'
  | 'invalid-minimum-runtime-version'
  | 'invalid-manifest-digest'
  | 'manifest-digest-mismatch'
  | 'invalid-signature'
  | 'signature-verifier-unavailable'
  | 'signature-mismatch';

export interface ModelManifestValidationIssue {
  readonly code: ModelManifestValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface ModelManifestValidationOptions {
  readonly supportedSchemaVersions?: readonly string[];
  /**
   * Sources accepted by this validation pass. Production code passes
   * `['production']` so fixture manifests are rejected; the default accepts
   * both so fixture manifests can be structurally validated in tests.
   */
  readonly allowedSources?: readonly ModelManifestSource[];
  /** External signature verifier (like evidence.ts trusted verifiers). */
  readonly verifySignature?: (payload: {
    digest: string;
    signature: string;
  }) => Promise<boolean>;
}

export interface ModelManifestValidationResult {
  readonly status: ModelManifestValidationStatus;
  readonly issues: readonly ModelManifestValidationIssue[];
  readonly manifest?: SegmentedModelManifest;
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const PLACEHOLDER_DIGEST_PATTERN = /^sha256:|segment-|placeholder-/i;
const QUANTIZATION_PATTERN = /^(?:q|int|fp|bf)[0-9]+$/i;
const MEMORY_BASIS_VALUES = ['measured', 'budgeted', 'estimated'] as const;

/**
 * Synchronous structural validation. This is the fail-fast gate used by the
 * Coordinator constructor: it never recomputes the digest (async crypto) but
 * rejects every structurally impossible manifest.
 */
export function validateModelManifestShape(
  input: unknown,
  options: ModelManifestValidationOptions = {},
): ModelManifestValidationResult {
  const issues: ModelManifestValidationIssue[] = [];
  if (!isRecord(input)) {
    issue(issues, 'invalid-manifest', '$', 'model manifest must be an object');
    return result('invalid', issues);
  }

  const manifest = input as Record<string, unknown>;
  const supported = options.supportedSchemaVersions ?? [MODEL_MANIFEST_SCHEMA_VERSION];
  if (typeof manifest.schemaVersion !== 'string' || manifest.schemaVersion.trim().length === 0) {
    issue(issues, 'invalid-manifest', '$.schemaVersion', 'schemaVersion must be a non-empty string');
  } else if (!supported.includes(manifest.schemaVersion)) {
    issue(
      issues,
      'unsupported-schema-version',
      '$.schemaVersion',
      `unsupported model manifest schema version: ${manifest.schemaVersion}`,
    );
  }

  const allowedSources = options.allowedSources ?? ['production', 'fixture'];
  if (
    typeof manifest.source !== 'string' ||
    (manifest.source !== 'production' && manifest.source !== 'fixture')
  ) {
    issue(issues, 'invalid-manifest', '$.source', "source must be 'production' or 'fixture'");
  } else if (!allowedSources.includes(manifest.source)) {
    issue(
      issues,
      'fixture-manifest-not-allowed',
      '$.source',
      `source '${manifest.source}' is not allowed; production code must reject fixture manifests`,
    );
  }

  validateModelMetadata(manifest, issues);
  validateRuntimeRequirements(manifest, issues);
  validateQuantization(manifest, issues);

  if (!Array.isArray(manifest.segments)) {
    issue(issues, 'empty-segments', '$.segments', 'segments must be an array');
  } else {
    validateSegments(manifest.segments as unknown[], manifest.totalLayers, issues);
  }
  validateManifestDigestFormat(manifest, issues);

  if (issues.length > 0) {
    return result('invalid', issues);
  }
  return result('valid', issues, input as unknown as SegmentedModelManifest);
}

/**
 * Asynchronous full verification: shape checks plus manifest digest
 * recomputation and optional signature verification.
 */
export async function validateModelManifest(
  input: unknown,
  options: ModelManifestValidationOptions = {},
): Promise<ModelManifestValidationResult> {
  const shape = validateModelManifestShape(input, options);
  if (shape.status !== 'valid' || shape.manifest === undefined) {
    return shape;
  }

  const manifest = shape.manifest;
  const issues: ModelManifestValidationIssue[] = [...shape.issues];

  const recomputed = await computeModelManifestDigest(manifest);
  if (recomputed !== manifest.manifestDigest.toLowerCase()) {
    issue(
      issues,
      'manifest-digest-mismatch',
      '$.manifestDigest',
      'manifest digest does not match the recomputed canonical digest',
    );
    return result('invalid', issues, manifest);
  }

  if (manifest.signature !== undefined) {
    if (typeof manifest.signature !== 'string' || manifest.signature.trim().length === 0) {
      issue(issues, 'invalid-signature', '$.signature', 'signature must be a non-empty string');
      return result('invalid', issues, manifest);
    }
    if (options.verifySignature === undefined) {
      issue(
        issues,
        'signature-verifier-unavailable',
        '$.signature',
        'signature is present but no verifySignature callback was provided',
      );
      return result('invalid', issues, manifest);
    }
    const verifies = await verifyModelManifestSignature(manifest, options.verifySignature);
    if (!verifies) {
      issue(
        issues,
        'signature-mismatch',
        '$.signature',
        'signature does not verify against the manifest digest',
      );
      return result('invalid', issues, manifest);
    }
  }

  return result('valid', issues, manifest);
}

/**
 * Fail-fast helper used by the Coordinator constructor. Throws on the first
 * structurally invalid manifest instead of letting a bad config drive an
 * execution plan.
 */
export function assertValidModelManifest(
  manifest: SegmentedModelManifest,
  options: ModelManifestValidationOptions = {},
): SegmentedModelManifest {
  const validation = validateModelManifestShape(manifest, options);
  if (validation.status !== 'valid' || validation.manifest === undefined) {
    const detail = validation.issues
      .map((item) => `${item.path} ${item.code}: ${item.message}`)
      .join('; ');
    throw new Error(`model manifest validation failed: ${detail}`);
  }
  return validation.manifest;
}

function validateModelMetadata(
  manifest: Record<string, unknown>,
  issues: ModelManifestValidationIssue[],
): void {
  requiredNonEmptyString(manifest, 'modelId', '$.modelId', issues, 'invalid-model-metadata');
  requiredNonEmptyString(
    manifest,
    'modelRevision',
    '$.modelRevision',
    issues,
    'invalid-model-metadata',
  );
  requiredNonEmptyString(
    manifest,
    'architecture',
    '$.architecture',
    issues,
    'invalid-model-metadata',
  );
  requiredNonEmptyString(manifest, 'tokenizer', '$.tokenizer', issues, 'invalid-model-metadata');
  requiredNonEmptyString(
    manifest,
    'checkpointFormat',
    '$.checkpointFormat',
    issues,
    'invalid-model-metadata',
  );
  if (
    typeof manifest.parameterCount !== 'number' ||
    !Number.isFinite(manifest.parameterCount) ||
    manifest.parameterCount <= 0
  ) {
    issue(
      issues,
      'invalid-model-metadata',
      '$.parameterCount',
      'parameterCount must be a positive number',
    );
  }
  if (
    typeof manifest.totalLayers !== 'number' ||
    !Number.isInteger(manifest.totalLayers) ||
    manifest.totalLayers < 1
  ) {
    issue(
      issues,
      'invalid-model-metadata',
      '$.totalLayers',
      'totalLayers must be a positive integer',
    );
  }
}

function validateRuntimeRequirements(
  manifest: Record<string, unknown>,
  issues: ModelManifestValidationIssue[],
): void {
  const requirements = manifest.runtimeRequirements;
  if (!isRecord(requirements)) {
    issue(
      issues,
      'invalid-runtime-requirements',
      '$.runtimeRequirements',
      'runtimeRequirements must be an object',
    );
    return;
  }
  if (
    typeof requirements.minimumVramMB !== 'number' ||
    !Number.isFinite(requirements.minimumVramMB) ||
    requirements.minimumVramMB <= 0
  ) {
    issue(
      issues,
      'invalid-runtime-requirements',
      '$.runtimeRequirements.minimumVramMB',
      'minimumVramMB must be a positive number',
    );
  }
  if (
    !Array.isArray(requirements.supportedQuantization) ||
    requirements.supportedQuantization.length === 0 ||
    !requirements.supportedQuantization.every(
      (value) => typeof value === 'string' && QUANTIZATION_PATTERN.test(value),
    )
  ) {
    issue(
      issues,
      'invalid-runtime-requirements',
      '$.runtimeRequirements.supportedQuantization',
      'supportedQuantization must be a non-empty array of quantization strings',
    );
  }
  requiredNonEmptyString(
    requirements,
    'minimumRuntimeVersion',
    '$.runtimeRequirements.minimumRuntimeVersion',
    issues,
    'invalid-runtime-requirements',
  );
  requiredNonEmptyString(
    requirements,
    'minimumChromeVersion',
    '$.runtimeRequirements.minimumChromeVersion',
    issues,
    'invalid-runtime-requirements',
  );
}

function validateQuantization(
  manifest: Record<string, unknown>,
  issues: ModelManifestValidationIssue[],
): void {
  const quantization = manifest.quantization;
  if (
    typeof quantization !== 'string' ||
    !QUANTIZATION_PATTERN.test(quantization) ||
    Number.isNaN(parseQuantizationBits(quantization))
  ) {
    issue(
      issues,
      'invalid-quantization',
      '$.quantization',
      'quantization must match q<int> / int<int> / fp<int> / bf<int>',
    );
    return;
  }

  const requirements = isRecord(manifest.runtimeRequirements)
    ? manifest.runtimeRequirements
    : undefined;
  const supported =
    requirements !== undefined && Array.isArray(requirements.supportedQuantization)
      ? requirements.supportedQuantization
      : [];
  if (!supported.some((value) => String(value).toLowerCase() === quantization.toLowerCase())) {
    issue(
      issues,
      'unsupported-quantization',
      '$.quantization',
      `quantization '${quantization}' is not listed in runtimeRequirements.supportedQuantization`,
    );
  }
}

function validateSegments(
  segments: unknown[],
  totalLayers: unknown,
  issues: ModelManifestValidationIssue[],
): void {
  if (segments.length === 0) {
    issue(issues, 'empty-segments', '$.segments', 'at least one segment artifact is required');
    return;
  }

  const indexes = new Set<number>();
  let layerNumbersValid = true;
  for (const [arrayIndex, artifact] of segments.entries()) {
    const path = `$.segments[${arrayIndex}]`;
    if (!isRecord(artifact)) {
      issue(issues, 'invalid-manifest', path, 'segment artifact must be an object');
      continue;
    }
    validateSegmentArtifact(artifact, path, totalLayers, indexes, issues);
  }

  const artifacts = segments as Record<string, unknown>[];
  if (!artifacts.every((artifact) => isRecord(artifact))) {
    return;
  }

  const sorted = [...artifacts].sort((a, b) => Number(a.index) - Number(b.index));
  const sortedIndexes = sorted.map((artifact) => Number(artifact.index));
  for (let index = 0; index < sortedIndexes.length; index++) {
    if (sortedIndexes[index] !== index) {
      issue(
        issues,
        'missing-segment-index',
        '$.segments',
        `segment indexes must be exactly 0..${segments.length - 1}; found ${sortedIndexes.join(', ')}`,
      );
      break;
    }
  }

  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      typeof previous.layerEnd !== 'number' ||
      typeof current.layerStart !== 'number' ||
      current.layerStart !== previous.layerEnd + 1
    ) {
      issue(
        issues,
        'non-contiguous-layer-ranges',
        '$.segments',
        `segment ${current.index} starts at layer ${String(current.layerStart)} but the previous segment ends at layer ${String(previous.layerEnd)}`,
      );
      layerNumbersValid = false;
      break;
    }
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (
    Number.isInteger(totalLayers) &&
    layerNumbersValid &&
    (Number(first.layerStart) !== 0 || Number(last.layerEnd) !== Number(totalLayers) - 1)
  ) {
    issue(
      issues,
      'segments-incomplete',
      '$.segments',
      `segments must cover layers 0..${Number(totalLayers) - 1}; got ${String(first.layerStart)}..${String(last.layerEnd)}`,
    );
  }
}

function validateSegmentArtifact(
  artifact: Record<string, unknown>,
  path: string,
  totalLayers: unknown,
  indexes: Set<number>,
  issues: ModelManifestValidationIssue[],
): void {
  if (
    typeof artifact.index !== 'number' ||
    !Number.isInteger(artifact.index) ||
    artifact.index < 0
  ) {
    issue(issues, 'invalid-manifest', `${path}.index`, 'index must be a non-negative integer');
  } else if (indexes.has(artifact.index)) {
    issue(issues, 'duplicate-segment-index', `${path}.index`, `duplicate segment index ${artifact.index}`);
  } else {
    indexes.add(artifact.index);
  }

  const layerStart = artifact.layerStart;
  const layerEnd = artifact.layerEnd;
  if (typeof layerStart !== 'number' || !Number.isInteger(layerStart) || layerStart < 0) {
    issue(issues, 'invalid-layer-range', `${path}.layerStart`, 'layerStart must be a non-negative integer');
  }
  if (typeof layerEnd !== 'number' || !Number.isInteger(layerEnd) || layerEnd < 0) {
    issue(issues, 'invalid-layer-range', `${path}.layerEnd`, 'layerEnd must be a non-negative integer');
  }
  if (
    typeof layerStart === 'number' &&
    typeof layerEnd === 'number' &&
    layerEnd < layerStart
  ) {
    issue(
      issues,
      'invalid-layer-range',
      path,
      `layerStart ${layerStart} exceeds layerEnd ${layerEnd}`,
    );
  }
  if (
    Number.isInteger(totalLayers) &&
    typeof layerEnd === 'number' &&
    layerEnd >= Number(totalLayers)
  ) {
    issue(
      issues,
      'layers-outside-model',
      `${path}.layerEnd`,
      `layerEnd ${layerEnd} exceeds totalLayers ${String(totalLayers)}`,
    );
  }

  if (
    typeof artifact.byteSize !== 'number' ||
    !Number.isFinite(artifact.byteSize) ||
    artifact.byteSize <= 0
  ) {
    issue(issues, 'invalid-artifact-byte-size', `${path}.byteSize`, 'byteSize must be a positive number');
  }

  const sha256 = artifact.sha256;
  if (typeof sha256 !== 'string' || PLACEHOLDER_DIGEST_PATTERN.test(sha256)) {
    issue(
      issues,
      'placeholder-artifact-digest',
      `${path}.sha256`,
      'placeholder artifact hashes (e.g. sha256:segment-0) are rejected; an exact SHA-256 is required',
    );
  } else if (!SHA256_HEX_PATTERN.test(sha256)) {
    issue(
      issues,
      'invalid-artifact-digest',
      `${path}.sha256`,
      'sha256 must be a 64-character lowercase hexadecimal digest',
    );
  }

  requiredNonEmptyString(
    artifact,
    'contentType',
    `${path}.contentType`,
    issues,
    'invalid-artifact-content-type',
  );
  requiredNonEmptyString(
    artifact,
    'artifactLocator',
    `${path}.artifactLocator`,
    issues,
    'invalid-artifact-locator',
  );
  if (
    typeof artifact.estimatedMemoryMB !== 'number' ||
    !Number.isFinite(artifact.estimatedMemoryMB) ||
    artifact.estimatedMemoryMB <= 0
  ) {
    issue(
      issues,
      'invalid-artifact-memory',
      `${path}.estimatedMemoryMB`,
      'estimatedMemoryMB must be a positive number',
    );
  }
  if (
    typeof artifact.memoryBasis !== 'string' ||
    !MEMORY_BASIS_VALUES.includes(artifact.memoryBasis as (typeof MEMORY_BASIS_VALUES)[number])
  ) {
    issue(
      issues,
      'invalid-memory-basis',
      `${path}.memoryBasis`,
      "memoryBasis must be 'measured' | 'budgeted' | 'estimated'",
    );
  }
  if (
    !Array.isArray(artifact.compatibleRuntimes) ||
    artifact.compatibleRuntimes.length === 0 ||
    !artifact.compatibleRuntimes.every(
      (value) => typeof value === 'string' && value.trim().length > 0,
    )
  ) {
    issue(
      issues,
      'invalid-compatible-runtimes',
      `${path}.compatibleRuntimes`,
      'compatibleRuntimes must be a non-empty array of runtime names',
    );
  }
  requiredNonEmptyString(
    artifact,
    'minimumRuntimeVersion',
    `${path}.minimumRuntimeVersion`,
    issues,
    'invalid-minimum-runtime-version',
  );
}

function validateManifestDigestFormat(
  manifest: Record<string, unknown>,
  issues: ModelManifestValidationIssue[],
): void {
  const digest = manifest.manifestDigest;
  if (typeof digest !== 'string' || !SHA256_HEX_PATTERN.test(digest)) {
    issue(
      issues,
      'invalid-manifest-digest',
      '$.manifestDigest',
      'manifestDigest must be a 64-character lowercase hexadecimal digest',
    );
  }
}

function requiredNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ModelManifestValidationIssue[],
  code: ModelManifestValidationIssueCode,
): void {
  if (typeof record[key] !== 'string' || record[key].trim().length === 0) {
    issue(issues, code, path, `${key} must be a non-empty string`);
  }
}

function issue(
  issues: ModelManifestValidationIssue[],
  code: ModelManifestValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function result(
  status: ModelManifestValidationStatus,
  issues: ModelManifestValidationIssue[],
  manifest?: SegmentedModelManifest,
): ModelManifestValidationResult {
  return { status, issues, manifest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
