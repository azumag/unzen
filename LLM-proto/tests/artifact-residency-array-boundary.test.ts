import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { workerId, type SegmentConfig } from '../src/types.js';

function makeArtifacts(byteSizes: readonly number[]): SegmentArtifact[] {
  return byteSizes.map((byteSize, index) => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/models/test/segment-${index}.onnx`,
    estimatedMemoryMB: 512 + index * 128,
    memoryBasis: 'measured',
    measurementConditions: 'array boundary fixture',
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

const hostileThrownValue = {
  toString(): string {
    throw new Error('hostile thrown value must not be stringified');
  },
  [Symbol.toPrimitive](): never {
    throw new Error('hostile thrown value must not be coerced');
  },
};

function throwOnAccess<T>(values: T[], property: PropertyKey): readonly T[] {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (key === property) {
        throw hostileThrownValue;
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

function guardedArray<T>(values: T[]): {
  readonly array: readonly T[];
  readonly reads: Map<PropertyKey, number>;
} {
  const reads = new Map<PropertyKey, number>();
  return {
    array: new Proxy(values, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          throw new Error('caller iterator must not run');
        }
        if (
          property === 'length' ||
          (typeof property === 'string' && /^\d+$/.test(property))
        ) {
          reads.set(property, (reads.get(property) ?? 0) + 1);
        }
        return Reflect.get(target, property, receiver);
      },
    }),
    reads,
  };
}

describe('ArtifactResidencyLedger caller-owned array boundary', () => {
  it('fails closed on revoked array proxies at all three public array entry points', () => {
    const revokedArtifacts = Proxy.revocable(makeArtifacts([100]), {});
    revokedArtifacts.revoke();
    expect(() => new ArtifactResidencyLedger(
      revokedArtifacts.proxy as unknown as readonly SegmentArtifact[],
    )).toThrow(/ArtifactResidencyLedger artifacts must be an array/);

    const artifacts = makeArtifacts([100]);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const revokedSegments = Proxy.revocable(makeSegments(artifacts), {});
    revokedSegments.revoke();
    expect(() => ledger.assertCompatibleSegments(
      revokedSegments.proxy as unknown as readonly SegmentConfig[],
    )).toThrow(/segment configs must be an array/);

    const worker = workerId('revoked-array-worker');
    ledger.synchronizeWorker(worker, [0]);
    const revokedIndexes = Proxy.revocable([0], {});
    revokedIndexes.revoke();
    expect(() => ledger.synchronizeWorker(
      worker,
      revokedIndexes.proxy as unknown as readonly number[],
    )).toThrow(/worker segmentIndexes must be an array/);
    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([0]);
  });

  it('maps throwing length and indexed reads to deterministic ledger-owned diagnostics', () => {
    expect(() => new ArtifactResidencyLedger(
      throwOnAccess(makeArtifacts([100]), 'length') as readonly SegmentArtifact[],
    )).toThrow(/ArtifactResidencyLedger artifacts length could not be read/);
    expect(() => new ArtifactResidencyLedger(
      throwOnAccess(makeArtifacts([100]), '0') as readonly SegmentArtifact[],
    )).toThrow(/ArtifactResidencyLedger artifact at position 0 could not be read/);

    const artifacts = makeArtifacts([100, 200]);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const segments = makeSegments(artifacts);
    expect(() => ledger.assertCompatibleSegments(
      throwOnAccess(segments, 'length') as readonly SegmentConfig[],
    )).toThrow(/segment configs length could not be read/);
    expect(() => ledger.assertCompatibleSegments(
      throwOnAccess(segments, '0') as readonly SegmentConfig[],
    )).toThrow(/segment config at position 0 could not be read/);

    const worker = workerId('throwing-array-worker');
    ledger.synchronizeWorker(worker, [0]);
    expect(() => ledger.synchronizeWorker(
      worker,
      throwOnAccess([1], 'length') as readonly number[],
    )).toThrow(/worker segmentIndexes length could not be read/);
    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([0]);
    expect(() => ledger.synchronizeWorker(
      worker,
      throwOnAccess([1], '0') as readonly number[],
    )).toThrow(/worker segment index at position 0 could not be read/);
    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([0]);
  });

  it('captures successful arrays by numeric index exactly once without invoking caller iterators', () => {
    const artifacts = makeArtifacts([100, 200]);
    const guardedArtifacts = guardedArray(artifacts);
    const ledger = new ArtifactResidencyLedger(
      guardedArtifacts.array as readonly SegmentArtifact[],
    );
    expect(guardedArtifacts.reads.get('length')).toBe(1);
    expect(guardedArtifacts.reads.get('0')).toBe(1);
    expect(guardedArtifacts.reads.get('1')).toBe(1);

    const guardedSegments = guardedArray(makeSegments(artifacts));
    expect(() => ledger.assertCompatibleSegments(
      guardedSegments.array as readonly SegmentConfig[],
    )).not.toThrow();
    expect(guardedSegments.reads.get('length')).toBe(1);
    expect(guardedSegments.reads.get('0')).toBe(1);
    expect(guardedSegments.reads.get('1')).toBe(1);

    const guardedIndexes = guardedArray([0, 1]);
    const snapshot = ledger.synchronizeWorker(
      workerId('numeric-index-worker'),
      guardedIndexes.array as readonly number[],
    );
    expect(snapshot.residentSegmentIndexes).toEqual([0, 1]);
    expect(guardedIndexes.reads.get('length')).toBe(1);
    expect(guardedIndexes.reads.get('0')).toBe(1);
    expect(guardedIndexes.reads.get('1')).toBe(1);
  });
});
