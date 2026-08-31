/**
 * Import the measured output of tools/multi_segment_onnx.py into the runtime
 * SegmentedModelManifest contract.
 *
 * The Python manifest describes an ONNX graph plus zero or more external-data
 * files for each logical browser cache unit. This adapter derives the exact
 * graph byte count from the measured bundle total, preserves every file digest
 * and locator, computes a content-only bundle digest, and finally computes and
 * validates the signed-manifest payload used by the Coordinator.
 */

import {
  BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
  BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
} from './browser-segment-artifact-budget.js';
import {
  MODEL_MANIFEST_SCHEMA_VERSION,
  computeModelManifestDigest,
  computeSegmentArtifactBundleDigest,
  type MemoryBasis,
  type ModelManifestSource,
  type ModelRuntimeRequirements,
  type SegmentArtifact,
  type SegmentArtifactComponent,
  type SegmentedModelManifest,
} from './model-manifest.js';
import { validateModelManifest } from './model-manifest-validator.js';

const GENERATED_SCHEMA_VERSION = '1.0.0';
const GENERATED_KIND = 'unzen-budgeted-multi-segment-onnx';
const GENERATED_LAYOUT = 'per-segment-external-data';
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export interface GeneratedOnnxManifestImportOptions {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly architecture: string;
  readonly parameterCount: number;
  readonly quantization: string;
  readonly tokenizer: string;
  readonly checkpointFormat: string;
  /** Directory URL containing the generated relative artifact paths. */
  readonly artifactBaseUrl: string;
  /** One shared estimate or one exact estimate per generated segment. */
  readonly estimatedMemoryMB: number | readonly number[];
  readonly memoryBasis: MemoryBasis;
  readonly measurementConditions?: string;
  readonly compatibleRuntimes: readonly string[];
  readonly minimumRuntimeVersion: string;
  readonly runtimeRequirements: ModelRuntimeRequirements;
  readonly source: ModelManifestSource;
}

interface ParsedGeneratedSegment {
  readonly index: number;
  readonly startLayer: number;
  readonly endLayer: number;
  readonly byteSize: number;
  readonly graphPath: string;
  readonly graphSha256: string;
  readonly externalData: readonly ParsedExternalData[];
}

interface ParsedExternalData {
  readonly path: string;
  readonly byteSize: number;
  readonly sha256: string;
}

/**
 * Convert and fully validate a budgeted Python split manifest. The function is
 * intentionally async because bundle and outer manifest SHA-256 values are
 * recomputed rather than trusted from caller-provided metadata.
 */
export async function importGeneratedOnnxSplitManifest(
  input: unknown,
  options: GeneratedOnnxManifestImportOptions,
): Promise<SegmentedModelManifest> {
  validateImportOptions(options);
  const generated = requireRecord(input, '$');
  requireExactString(generated, 'schemaVersion', GENERATED_SCHEMA_VERSION, '$');
  requireExactString(generated, 'kind', GENERATED_KIND, '$');
  requireExactString(generated, 'artifactLayout', GENERATED_LAYOUT, '$');

  const budget = parseBudget(generated.browserArtifactBudget);
  if (!Array.isArray(generated.segments) || generated.segments.length === 0) {
    throw new Error('$.segments must be a non-empty array');
  }
  const parsedSegments = generated.segments.map((segment, index) =>
    parseGeneratedSegment(segment, index, budget),
  );
  validateGeneratedGeometry(parsedSegments);

  const memoryEstimates = resolveMemoryEstimates(
    options.estimatedMemoryMB,
    parsedSegments.length,
  );
  const baseUrl = normalizeArtifactBaseUrl(options.artifactBaseUrl, options.source);
  const runtimeSegments: SegmentArtifact[] = [];

  for (const [arrayIndex, segment] of parsedSegments.entries()) {
    const externalBytes = segment.externalData.reduce(
      (sum, entry) => safeAdd(sum, entry.byteSize, `segment ${segment.index} external bytes`),
      0,
    );
    const graphBytes = segment.byteSize - externalBytes;
    if (!Number.isSafeInteger(graphBytes) || graphBytes <= 0) {
      throw new Error(
        `segment ${segment.index} graph byte size must be positive after subtracting ` +
        `${externalBytes} external bytes from measured total ${segment.byteSize}`,
      );
    }

    const graphLocator = artifactLocator(baseUrl, segment.graphPath);
    const components: SegmentArtifactComponent[] = [
      {
        role: 'graph',
        path: segment.graphPath,
        byteSize: graphBytes,
        sha256: segment.graphSha256,
        contentType: 'application/onnx',
        artifactLocator: graphLocator,
      },
      ...segment.externalData.map((entry): SegmentArtifactComponent => ({
        role: 'external-data',
        path: entry.path,
        byteSize: entry.byteSize,
        sha256: entry.sha256,
        contentType: 'application/octet-stream',
        artifactLocator: artifactLocator(baseUrl, entry.path),
      })),
    ];
    const bundleDigest = await computeSegmentArtifactBundleDigest(components);
    const runtimeSegment: SegmentArtifact = {
      index: segment.index,
      layerStart: segment.startLayer,
      layerEnd: segment.endLayer - 1,
      byteSize: segment.byteSize,
      sha256: bundleDigest,
      contentType: 'application/vnd.unzen.onnx-segment-bundle',
      artifactLocator: graphLocator,
      components,
      estimatedMemoryMB: memoryEstimates[arrayIndex],
      memoryBasis: options.memoryBasis,
      compatibleRuntimes: [...options.compatibleRuntimes],
      minimumRuntimeVersion: options.minimumRuntimeVersion,
      ...(options.measurementConditions === undefined
        ? {}
        : { measurementConditions: options.measurementConditions }),
    };
    runtimeSegments.push(runtimeSegment);
  }

  const provisional: SegmentedModelManifest = {
    schemaVersion: MODEL_MANIFEST_SCHEMA_VERSION,
    modelId: options.modelId,
    modelRevision: options.modelRevision,
    architecture: options.architecture,
    parameterCount: options.parameterCount,
    quantization: options.quantization,
    totalLayers: parsedSegments[parsedSegments.length - 1].endLayer,
    tokenizer: options.tokenizer,
    segments: runtimeSegments,
    checkpointFormat: options.checkpointFormat,
    runtimeRequirements: {
      ...options.runtimeRequirements,
      supportedQuantization: [...options.runtimeRequirements.supportedQuantization],
    },
    manifestDigest: '0'.repeat(64),
    source: options.source,
  };
  const manifest: SegmentedModelManifest = {
    ...provisional,
    manifestDigest: await computeModelManifestDigest(provisional),
  };
  const validation = await validateModelManifest(manifest, {
    allowedSources: [options.source],
  });
  if (validation.status !== 'valid') {
    const detail = validation.issues
      .map((issue) => `${issue.path} ${issue.code}: ${issue.message}`)
      .join('; ');
    throw new Error(`imported model manifest validation failed: ${detail}`);
  }
  return manifest;
}

function parseBudget(value: unknown): {
  readonly requiredMaxBytes: number;
  readonly absoluteMaxBytes: number;
} {
  const budget = requireRecord(value, '$.browserArtifactBudget');
  const requiredMaxBytes = requireSafePositiveInteger(
    budget.requiredMaxBytes,
    '$.browserArtifactBudget.requiredMaxBytes',
  );
  const absoluteMaxBytes = requireSafePositiveInteger(
    budget.absoluteMaxBytes,
    '$.browserArtifactBudget.absoluteMaxBytes',
  );
  // Generated metadata is untrusted input. It may tighten product policy, but
  // it may never advertise a larger browser allowance than runtime permits.
  if (requiredMaxBytes > BROWSER_SEGMENT_PREFERRED_MAX_BYTES) {
    throw new Error(
      '$.browserArtifactBudget.requiredMaxBytes cannot relax the product preferred ceiling ' +
      `of ${BROWSER_SEGMENT_PREFERRED_MAX_BYTES} bytes`,
    );
  }
  if (absoluteMaxBytes > BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES) {
    throw new Error(
      '$.browserArtifactBudget.absoluteMaxBytes cannot relax the product absolute ceiling ' +
      `of ${BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES} bytes`,
    );
  }
  if (requiredMaxBytes > absoluteMaxBytes) {
    throw new Error(
      '$.browserArtifactBudget.requiredMaxBytes cannot exceed absoluteMaxBytes',
    );
  }
  return { requiredMaxBytes, absoluteMaxBytes };
}

function parseGeneratedSegment(
  value: unknown,
  arrayIndex: number,
  budget: { readonly requiredMaxBytes: number; readonly absoluteMaxBytes: number },
): ParsedGeneratedSegment {
  const path = `$.segments[${arrayIndex}]`;
  const segment = requireRecord(value, path);
  const index = requireNonNegativeInteger(segment.index, `${path}.index`);
  if (index !== arrayIndex) {
    throw new Error(`${path}.index must be ${arrayIndex}; found ${index}`);
  }
  const startLayer = requireNonNegativeInteger(segment.startLayer, `${path}.startLayer`);
  const endLayer = requireNonNegativeInteger(segment.endLayer, `${path}.endLayer`);
  if (endLayer <= startLayer) {
    throw new Error(`${path}.endLayer must be greater than startLayer`);
  }
  const byteSize = requireSafePositiveInteger(
    segment.browserArtifactBytes,
    `${path}.browserArtifactBytes`,
  );
  if (byteSize > budget.requiredMaxBytes) {
    throw new Error(
      `segment ${index} exceeds required browser budget: ` +
      `${byteSize} > ${budget.requiredMaxBytes} bytes`,
    );
  }
  if (byteSize > budget.absoluteMaxBytes) {
    throw new Error(
      `segment ${index} exceeds absolute browser budget: ` +
      `${byteSize} > ${budget.absoluteMaxBytes} bytes`,
    );
  }

  const graphPath = requireSafeRelativePath(segment.path, `${path}.path`);
  const graphSha256 = requireSha256(segment.sha256, `${path}.sha256`);
  if (!Array.isArray(segment.externalData)) {
    throw new Error(`${path}.externalData must be an array`);
  }
  const externalData = segment.externalData.map((entry, externalIndex) => {
    const externalPath = `${path}.externalData[${externalIndex}]`;
    const record = requireRecord(entry, externalPath);
    return {
      path: requireSafeRelativePath(record.location, `${externalPath}.location`),
      byteSize: requireSafePositiveInteger(record.bytes, `${externalPath}.bytes`),
      sha256: requireSha256(record.sha256, `${externalPath}.sha256`),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  const paths = new Set<string>([graphPath]);
  for (const external of externalData) {
    if (paths.has(external.path)) {
      throw new Error(`segment ${index} contains duplicate artifact path ${external.path}`);
    }
    paths.add(external.path);
  }

  return {
    index,
    startLayer,
    endLayer,
    byteSize,
    graphPath,
    graphSha256,
    externalData,
  };
}

function validateGeneratedGeometry(segments: readonly ParsedGeneratedSegment[]): void {
  if (segments[0].startLayer !== 0) {
    throw new Error(`generated segment layers must start at 0; found ${segments[0].startLayer}`);
  }
  for (let index = 1; index < segments.length; index++) {
    if (segments[index].startLayer !== segments[index - 1].endLayer) {
      throw new Error(
        `generated segment layer ranges must be contiguous: segment ${index - 1} ends at ` +
        `${segments[index - 1].endLayer}, segment ${index} starts at ${segments[index].startLayer}`,
      );
    }
  }
}

function resolveMemoryEstimates(
  configured: number | readonly number[],
  segmentCount: number,
): readonly number[] {
  if (typeof configured === 'number') {
    const estimate = requirePositiveFiniteNumber(configured, 'estimatedMemoryMB');
    return Array.from({ length: segmentCount }, () => estimate);
  }
  if (!Array.isArray(configured) || configured.length !== segmentCount) {
    throw new Error(
      `estimatedMemoryMB array length must match segment count ${segmentCount}`,
    );
  }
  return configured.map((value, index) =>
    requirePositiveFiniteNumber(value, `estimatedMemoryMB[${index}]`),
  );
}

function normalizeArtifactBaseUrl(
  raw: string,
  source: ModelManifestSource,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`artifactBaseUrl must be an absolute URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('artifactBaseUrl must use HTTP or HTTPS');
  }
  if (source === 'production' && url.protocol !== 'https:') {
    throw new Error('production artifactBaseUrl must use HTTPS');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('artifactBaseUrl must not contain credentials');
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('artifactBaseUrl must not contain a query string or fragment');
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url;
}

function artifactLocator(baseUrl: URL, relativePath: string): string {
  const encoded = relativePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return new URL(encoded, baseUrl).toString();
}

function validateImportOptions(options: GeneratedOnnxManifestImportOptions): void {
  for (const [name, value] of Object.entries({
    modelId: options.modelId,
    modelRevision: options.modelRevision,
    architecture: options.architecture,
    quantization: options.quantization,
    tokenizer: options.tokenizer,
    checkpointFormat: options.checkpointFormat,
    minimumRuntimeVersion: options.minimumRuntimeVersion,
  })) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${name} must be a non-empty string`);
    }
  }
  requirePositiveFiniteNumber(options.parameterCount, 'parameterCount');
  if (options.source !== 'fixture' && options.source !== 'production') {
    throw new Error("source must be 'fixture' or 'production'");
  }
  if (
    !Array.isArray(options.compatibleRuntimes) ||
    options.compatibleRuntimes.length === 0 ||
    !options.compatibleRuntimes.every(
      (runtime) => typeof runtime === 'string' && runtime.trim().length > 0,
    )
  ) {
    throw new Error('compatibleRuntimes must be a non-empty string array');
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactString(
  record: Record<string, unknown>,
  key: string,
  expected: string,
  path: string,
): void {
  if (record[key] !== expected) {
    throw new Error(`${path}.${key} must be '${expected}'`);
  }
}

function requireSafeRelativePath(value: unknown, path: string): string {
  if (typeof value !== 'string' || !isSafeRelativePath(value)) {
    throw new Error(`${path} must be a safe relative path`);
  }
  return value;
}

function isSafeRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return false;
  }
  const parts = path.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function requireSha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
    throw new Error(`${path} must be a lowercase 64-character SHA-256 digest`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

function requireSafePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a safe positive integer`);
  }
  return value;
}

function requirePositiveFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive finite number`);
  }
  return value;
}

function safeAdd(left: number, right: number, path: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`${path} exceeds JavaScript safe integer range`);
  }
  return sum;
}
