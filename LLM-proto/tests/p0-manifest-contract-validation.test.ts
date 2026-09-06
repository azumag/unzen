import { describe, expect, it } from 'vitest';
import {
  SMOLLM2_P0_CONTRACT,
  validateSmolLm2P0Manifest,
  validateSmolLm2P0RuntimeParameters,
} from '../browser-harness/webgpu-2b-split/p0-manifest-contract.js';

function validManifest() {
  const c = SMOLLM2_P0_CONTRACT;
  const segmentBytes = [90 * 1024 * 1024, 96 * 1024 * 1024];
  return {
    schemaVersion: c.schemaVersion,
    kind: c.manifestKind,
    artifactLayout: c.artifactLayout,
    sourceModel: {
      sha256: c.sourceGraphSha256,
      externalData: [{
        location: c.sourceExternalDataLocation,
        bytes: c.sourceExternalDataBytes,
        sha256: c.sourceExternalDataSha256,
      }],
    },
    splitLayer: c.splitLayer,
    hiddenSize: c.hiddenSize,
    boundary: {
      dtype: 'float32',
      tensorCount: c.boundaryTensorCount,
      bytesPerToken: c.boundaryBytesPerToken,
      tensors: [{ name: 'residual' }, { name: 'mlp' }],
    },
    segments: segmentBytes.map((browserArtifactBytes, index) => ({
      index,
      browserArtifactBytes,
      browserArtifactTier: 'preferred',
    })),
    modelProfile: {
      modelId: c.modelId,
      revision: c.modelRevision,
      modelClass: c.modelClass,
      quantization: c.quantization,
      totalLayers: c.totalLayers,
      splitLayer: c.splitLayer,
      runtimeHints: {
        hiddenSize: c.hiddenSize,
        kvHeads: c.kvHeads,
        headSize: c.headSize,
      },
    },
    browserArtifactBudget: {
      targetBytes: c.targetBytes,
      preferredMaxBytes: c.preferredMaxBytes,
      normalMaxBytes: c.normalMaxBytes,
      absoluteMaxBytes: c.absoluteMaxBytes,
      requiredTier: c.requiredTier,
      requiredMaxBytes: c.preferredMaxBytes,
      maximumSegmentArtifactBytes: Math.max(...segmentBytes),
      segments: segmentBytes.map((artifactBytes, index) => ({
        index,
        artifactBytes,
        tier: 'preferred',
      })),
    },
  };
}

describe('SmolLM2 P0 manifest provenance contract', () => {
  it('requires P0 execution parameters to match the pinned model geometry', () => {
    expect(validateSmolLm2P0RuntimeParameters({
      modelId: SMOLLM2_P0_CONTRACT.modelId,
      kvHeads: SMOLLM2_P0_CONTRACT.kvHeads,
      headSize: SMOLLM2_P0_CONTRACT.headSize,
    })).toMatchObject({ status: 'pass' });

    expect(() => validateSmolLm2P0RuntimeParameters({
      modelId: 'onnx-community/Llama-3.2-1B-Instruct',
      kvHeads: SMOLLM2_P0_CONTRACT.kvHeads,
      headSize: SMOLLM2_P0_CONTRACT.headSize,
    })).toThrow(/runtime\.modelId mismatch/);
    expect(() => validateSmolLm2P0RuntimeParameters({
      modelId: SMOLLM2_P0_CONTRACT.modelId,
      kvHeads: 8,
      headSize: SMOLLM2_P0_CONTRACT.headSize,
    })).toThrow(/runtime\.kvHeads mismatch/);
  });

  it('accepts the pinned source, geometry and preferred-budget contract', () => {
    expect(validateSmolLm2P0Manifest(validManifest())).toEqual({
      status: 'pass',
      modelId: SMOLLM2_P0_CONTRACT.modelId,
      modelRevision: SMOLLM2_P0_CONTRACT.modelRevision,
      sourceGraphSha256: SMOLLM2_P0_CONTRACT.sourceGraphSha256,
      requiredTier: 'preferred',
      requiredMaxBytes: 256 * 1024 * 1024,
      segmentCount: 2,
    });
  });

  it('rejects a manifest generated from a different source graph', () => {
    const manifest = validManifest();
    manifest.sourceModel.sha256 = 'b'.repeat(64);
    expect(() => validateSmolLm2P0Manifest(manifest)).toThrow(/sourceModel\.sha256 mismatch/);
  });

  it('rejects source external-data drift or missing provenance', () => {
    const wrongDigest = validManifest();
    wrongDigest.sourceModel.externalData[0].sha256 = 'c'.repeat(64);
    expect(() => validateSmolLm2P0Manifest(wrongDigest)).toThrow(/externalData\[0\]\.sha256 mismatch/);

    const missingDigest = validManifest();
    delete (missingDigest.sourceModel.externalData[0] as any).sha256;
    expect(() => validateSmolLm2P0Manifest(missingDigest)).toThrow(/canonical lowercase SHA-256/);
  });

  it('rejects model revision or runtime geometry drift', () => {
    const wrongRevision = validManifest();
    wrongRevision.modelProfile.revision = 'main';
    expect(() => validateSmolLm2P0Manifest(wrongRevision)).toThrow(/modelProfile\.revision mismatch/);

    const wrongGeometry = validManifest();
    wrongGeometry.modelProfile.runtimeHints.kvHeads = 4;
    expect(() => validateSmolLm2P0Manifest(wrongGeometry)).toThrow(/runtimeHints\.kvHeads mismatch/);
  });

  it('rejects policy relaxation and budget-report drift', () => {
    const relaxed = validManifest();
    relaxed.browserArtifactBudget.requiredTier = 'absolute';
    expect(() => validateSmolLm2P0Manifest(relaxed)).toThrow(/requiredTier mismatch/);

    const drifted = validManifest();
    drifted.browserArtifactBudget.segments[0].artifactBytes += 1;
    expect(() => validateSmolLm2P0Manifest(drifted)).toThrow(/artifactBytes mismatch/);
  });

  it('rejects coercible JSON types instead of normalizing them', () => {
    const manifest = validManifest();
    (manifest.segments[0] as any).browserArtifactBytes = String(manifest.segments[0].browserArtifactBytes);
    expect(() => validateSmolLm2P0Manifest(manifest)).toThrow(/positive safe integer/);
  });
});
