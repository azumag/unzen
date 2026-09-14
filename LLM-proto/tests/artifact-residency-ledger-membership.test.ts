import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import type { SegmentConfig } from '../src/types.js';

function makeArtifacts(): SegmentArtifact[] {
  return [0, 1].map((index) => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize: 100 + index * 100,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/models/test/segment-${index}.onnx`,
    estimatedMemoryMB: 512 + index * 128,
    memoryBasis: 'measured',
    measurementConditions: 'membership fixture',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  }));
}

function makeSegments(artifacts: readonly SegmentArtifact[]): SegmentConfig[] {
  return artifacts.map((artifact) => ({
    index: artifact.index,
    layerStart: artifact.layerStart,
    layerEnd: artifact.layerEnd,
    modelWeightHash: artifact.sha256,
    estimatedVramMB: artifact.estimatedMemoryMB,
  }));
}

describe('ArtifactResidencyLedger top-level membership ownership', () => {
  it('captures every artifact reference before an early field getter can replace a later slot', () => {
    const base = makeArtifacts();
    const originalSecond = base[1];
    const replacementSecond: SegmentArtifact = {
      ...originalSecond,
      byteSize: 999,
      sha256: 'f'.repeat(64),
    };
    const artifacts: SegmentArtifact[] = [];
    const first = {
      ...base[0],
      get index() {
        artifacts[1] = replacementSecond;
        return 0;
      },
    } as unknown as SegmentArtifact;
    artifacts.push(first, originalSecond);

    const ledger = new ArtifactResidencyLedger(artifacts);

    expect(artifacts[1]).toBe(replacementSecond);
    expect(ledger.getArtifact(1).byteSize).toBe(originalSecond.byteSize);
    expect(ledger.getArtifact(1).sha256).toBe(originalSecond.sha256);
    expect(ledger.totalArtifactBytes).toBe(300);
  });

  it('captures every SegmentConfig reference before compatibility validation reads entry fields', () => {
    const artifacts = makeArtifacts();
    const ledger = new ArtifactResidencyLedger(artifacts);
    const baseSegments = makeSegments(artifacts);
    const originalSecond = baseSegments[1];
    const replacementSecond: SegmentConfig = {
      ...originalSecond,
      modelWeightHash: 'f'.repeat(64),
    };
    const segments: SegmentConfig[] = [];
    const first = {
      ...baseSegments[0],
      get index() {
        segments[1] = replacementSecond;
        return 0;
      },
    } as unknown as SegmentConfig;
    segments.push(first, originalSecond);

    expect(() => ledger.assertCompatibleSegments(segments)).not.toThrow();
    expect(segments[1]).toBe(replacementSecond);
  });
});
