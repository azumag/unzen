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

export type SegmentArtifactComponentRole = 'graph' | 'external-data';

/** One independently verifiable file inside a logical browser segment bundle. */
export interface SegmentArtifactComponent {
  readonly role: SegmentArtifactComponentRole;
  /** Safe relative path used by ONNX external-data references. */
  readonly path: string;
  readonly byteSize: number;
  /** Exact lowercase hexadecimal SHA-256 of this file's bytes. */
  readonly sha256: string;
  readonly contentType: string;
  readonly artifactLocator: string;
}

/** One contiguous, verifiable model artifact or logical multi-file bundle. */
export interface SegmentArtifact {
  /** Stable zero-based segment index (must be unique and cover 0..n-1). */
  readonly index: number;
  /** First transformer layer in this segment (inclusive). */
  readonly layerStart: number;
  /** Last transformer layer in this segment (inclusive). */
  readonly layerEnd: number;
  /** Exact total bytes fetched for this logical browser cache unit. */
  readonly byteSize: number;
  /**
   * Single-file artifact: exact SHA-256 of the file bytes.
   * Multi-file artifact: SHA-256 of canonical component content descriptors
   * (see computeSegmentArtifactBundleDigest). Every component also has its own
   * file digest, while the outer manifest digest binds deployment locators.
   */
  readonly sha256: string;
  /** MIME type of the file or logical bundle. */
  readonly contentType: string;
  /** Optional content encoding, e.g. 'zstd'. */
  readonly encoding?: string;
  /** Primary locator. For a component bundle this must identify the ONNX graph. */
  readonly artifactLocator: string;
  /**
   * Optional files composing one cache/residency unit. Legacy single-file
   * manifests omit this field and retain their existing semantics.
   */
  readonly components?: readonly SegmentArtifactComponent[];
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
 * (issue #102): layer ranges, VRAM, and weight/bundle hashes are artifact facts.
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
 * Canonical content-only component descriptors for a logical segment bundle.
 * Deployment locators are deliberately excluded: publishing identical bytes at
 * a new CDN URL does not change model-weight identity. The outer manifest
 * digest still covers all locators and therefore detects routing tampering.
 */
export function canonicalSegmentArtifactBundleFields(
  components: readonly SegmentArtifactComponent[],
): readonly Record<string, unknown>[] {
  return [...components]
    .sort((left, right) =>
      componentRoleOrder(left.role) - componentRoleOrder(right.role) ||
      left.path.localeCompare(right.path),
    )
    .map((component) => ({
      role: component.role,
      path: component.path,
      byteSize: component.byteSize,
      sha256: component.sha256,
      contentType: component.contentType,
    }));
}

/** Compute the stable content identity for a multi-file segment bundle. */
export async function computeSegmentArtifactBundleDigest(
  components: readonly SegmentArtifactComponent[],
): Promise<string> {
  const canonical = JSON.stringify(canonicalSegmentArtifactBundleFields(components));
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return sha256HexFromBuffer(digest);
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

function componentRoleOrder(role: SegmentArtifactComponentRole): number {
  return role === 'graph' ? 0 : 1;
}

function sha256HexFromBuffer(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
