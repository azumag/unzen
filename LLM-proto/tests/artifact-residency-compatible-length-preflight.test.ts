import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import type { SegmentConfig } from '../src/types.js';

function makeArtifacts(): SegmentArtifact[] {
  return [0, 1].map((index) => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize: 100 + index,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/models/test/segment-${index}.onnx`,
    estimatedMemoryMB: 512 + index * 128,
    memoryBasis: 'measured',
    measurementConditions: 'compatibility length preflight fixture',
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

describe('ArtifactResidencyLedger compatibility length preflight', () => {
  it('rejects a mismatched safe-integer length before any numeric index read', () => {
    const artifacts = makeArtifacts();
    const ledger = new ArtifactResidencyLedger(artifacts);
    const segments = makeSegments(artifacts);
    let numericIndexReads = 0;

    const oversized = new Proxy(segments, {
      get(target, property, receiver) {
        if (property === 'length') {
          return Number.MAX_SAFE_INTEGER;
        }
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          numericIndexReads++;
          throw new Error('numeric index must not be read after a length mismatch');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      ledger.assertCompatibleSegments(oversized as unknown as readonly SegmentConfig[]),
    ).toThrow(
      `segment config count ${Number.MAX_SAFE_INTEGER} does not match artifact count 2`,
    );
    expect(numericIndexReads).toBe(0);
  });

  it('keeps exactly-sized compatibility arrays on numeric-index read-once capture', () => {
    const artifacts = makeArtifacts();
    const ledger = new ArtifactResidencyLedger(artifacts);
    const segments = makeSegments(artifacts);
    const reads = new Map<PropertyKey, number>();

    const guarded = new Proxy(segments, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('caller iterator must not run');
        }
        if (property === 'length' || (typeof property === 'string' && /^\d+$/.test(property))) {
          reads.set(property, (reads.get(property) ?? 0) + 1);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => ledger.assertCompatibleSegments(guarded)).not.toThrow();
    expect(reads.get('length')).toBe(1);
    expect(reads.get('0')).toBe(1);
    expect(reads.get('1')).toBe(1);
  });
});
