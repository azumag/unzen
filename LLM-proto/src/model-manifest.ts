/**
 * Versioned segmented model manifest.
 *
 * Issue #102: replaces hard-coded model geometry (60 layers / 17GB / 8 segments
 * / placeholder `sha256:segment-${i}` hashes) with a validated artifact
 * manifest. The manifest is the single source of truth for segment geometry:
 * production consumers (e.g. Coordinator) fail fast at startup when the
 * manifest is invalid or not a production manifest.
 */

import type { SegmentConfig } from './types.js';

export const MODEL_MANIFEST_SCHEMA_VERSION = '1.0.0' as const;

/**
 * Fixture namespace marker. Test fixtures declare `source: 'fixture'` and the
 * production code path (Coordinator) must reject them, so a hand-written
 * fixture can never be mistaken for a real model manifest.
 */
export type ModelManifestSource = 'production' | 'fixture';

/**
 * Basis for a per-segment memory estimate. Only `measured` is a real
 * measurement; the 30B example in the fixtures is `budgeted`, not fact.
 */
export type MemoryBasis = 'measured' | 'budgeted' | 'estimated';

/** One contiguous, verifiable model weight shard. */
export interface SegmentArtifact {
  /** Stable zero-based segment index (must be unique and cover 0..n-1). */
  readonly index: number;
  /** First transformer layer in this segment (inclusive). */
  readonly layerStart: number;
  /** Last transformer layer in this segment (inclusive). */
  readonly layerEnd: number;
  /** Exact byte size of the artifact file. */
  readonly byteSize: number;
  /**
   * Exact lowercase hexadecimal SHA-256 of the artifact content.
   * Placeholder values such as `sha256:segment-0` are rejected by the
   * validator; only real digests are accepted.
   */
  readonly sha256: string;
  /** MIME type of the artifact, e.g. 'application/octet-stream'. */
  readonly contentType: string;
  /** Optional content encoding, e.g. 'zstd'. */
  readonly encoding?: string;
  /** CDN artifact locator (unzen-managed origin only). */
  readonly artifactLocator: string;
  /** Estimated peak VRAM (MB) while this segment is resident. */
  readonly estimatedMemoryMB: number;
  /** Basis for the memory estimate (measured / budgeted / estimated). */
  readonly memoryBasis: MemoryBasis;
  /** Conditions under which the measurement or estimate was taken. */
  readonly measurementConditions?: string;
  /** Inference runtimes that can execute this segment, e.g. ['webllm']. */
  readonly compatibleRuntimes: readonly string[];
  /** Minimum runtime version required for this segment. */
  readonly minimumRuntimeVersion: string;
}

export interface ModelRuntimeRequirements {
  /** Minimum GPU memory (MB) required for one segment plus runtime overhead. */
  readonly minimumVramMB: number;
  /** Quantization formats this model family supports, e.g. ['q4']. */
  readonly supportedQuantization: readonly string[];
  /** Minimum inference runtime version, e.g. '0.2.57'. */
  readonly minimumRuntimeVersion: string;
  /** Minimum Chrome/Chromium version for WebGPU availability. */
  readonly minimumChromeVersion: string;
}

export interface SegmentedModelManifest {
  readonly schemaVersion: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly architecture: string;
  readonly parameterCount: number;
  /** Quantization format string, e.g. 'q4' (see parseQuantizationBits). */
  readonly quantization: string;
  readonly totalLayers: number;
  readonly tokenizer: string;
  readonly segments: readonly SegmentArtifact[];
  readonly checkpointFormat: string;
  readonly runtimeRequirements: ModelRuntimeRequirements;
  /** SHA-256 over the canonical manifest fields (see computeModelManifestDigest). */
  readonly manifestDigest: string;
  /** Optional signature over the manifest digest. */
  readonly signature?: string;
  /** Fixture namespace marker; production code rejects non-production sources. */
  readonly source: ModelManifestSource;
}

/**
 * Derive the execution-facing SegmentConfig list from validated manifest
 * artifacts. SegmentConfig geometry now comes exclusively from the manifest
 * (issue #102): layer ranges, VRAM, and weight hashes are artifact facts.
 */
export function segmentConfigsFromManifest(
  manifest: SegmentedModelManifest,
): SegmentConfig[] {
  return manifest.segments.map((artifact) => ({
    index: artifact.index,
    layerStart: artifact.layerStart,
    layerEnd: artifact.layerEnd,
    modelWeightHash: artifact.sha256,
    estimatedVramMB: artifact.estimatedMemoryMB,
  }));
}

/** Parse a quantization string like 'q4' / 'fp16' / 'bf16' into a bit width. */
export function parseQuantizationBits(quantization: string): number {
  const match = /^(?:q|int|fp|bf)([0-9]+)$/i.exec(quantization);
  return match ? Number(match[1]) : Number.NaN;
}

/**
 * Build the canonical field set that the manifest digest covers.
 * `manifestDigest` and `signature` are excluded so the digest is recomputable
 * from the signed payload alone. `source` is included so the digest binds the
 * fixture marker used by the production rejection path.
 */
export function canonicalModelManifestFields(
  manifest: SegmentedModelManifest,
): Record<string, unknown> {
  return {
    schemaVersion: manifest.schemaVersion,
    modelId: manifest.modelId,
    modelRevision: manifest.modelRevision,
    architecture: manifest.architecture,
    parameterCount: manifest.parameterCount,
    quantization: manifest.quantization,
    totalLayers: manifest.totalLayers,
    tokenizer: manifest.tokenizer,
    segments: manifest.segments,
    checkpointFormat: manifest.checkpointFormat,
    runtimeRequirements: manifest.runtimeRequirements,
    source: manifest.source,
  };
}

/**
 * Compute the SHA-256 manifest digest over the canonical field set.
 * Uses the same crypto pattern as evidence.ts
 * (`globalThis.crypto.subtle.digest`).
 */
export async function computeModelManifestDigest(
  manifest: SegmentedModelManifest,
): Promise<string> {
  const canonical = JSON.stringify(canonicalModelManifestFields(manifest));
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return sha256HexFromBuffer(digest);
}

/**
 * Verify an optional signature over the manifest digest. The verifier callback
 * is supplied by the caller (like evidence.ts trusted verifiers) so the
 * manifest module never embeds a key.
 */
export async function verifyModelManifestSignature(
  manifest: SegmentedModelManifest,
  verify: (payload: { digest: string; signature: string }) => Promise<boolean>,
): Promise<boolean> {
  if (manifest.signature === undefined) {
    return true;
  }
  return verify({ digest: manifest.manifestDigest, signature: manifest.signature });
}

function sha256HexFromBuffer(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
