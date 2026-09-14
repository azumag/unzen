import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { workerId } from '../src/types.js';

function makeArtifacts(): SegmentArtifact[] {
  return [0, 1].map((index) => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize: 100 + index * 100,
    sha256: String(index + 1).repeat(64),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/models/test/segment-${index}.onnx`,
    estimatedMemoryMB: 512,
    memoryBasis: 'measured',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  }));
}

describe('ArtifactResidencyLedger synchronizeWorker runtime envelope', () => {
  it('captures indexes by position without invoking a caller-overridden iterator', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const worker = workerId('worker-a');
    const indexes = [1, 1, 0];
    Object.defineProperty(indexes, Symbol.iterator, {
      configurable: true,
      value() {
        throw new Error('custom iterator must not run');
      },
    });

    expect(ledger.synchronizeWorker(worker, indexes)).toMatchObject({
      residentSegmentIndexes: [0, 1],
      residentArtifactBytes: 300,
    });
  });

  it('reads each captured index once', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const worker = workerId('worker-a');
    const indexes: unknown[] = [0];
    let reads = 0;
    Object.defineProperty(indexes, '0', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 1 : Symbol('altered-index');
      },
    });

    const snapshot = ledger.synchronizeWorker(
      worker,
      indexes as readonly number[],
    );

    expect(snapshot.residentSegmentIndexes).toEqual([1]);
    expect(reads).toBe(1);
  });

  it('fails closed on membership shrink and leaves prior residency unchanged', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const worker = workerId('worker-a');
    ledger.synchronizeWorker(worker, [0]);

    const indexes: unknown[] = [1, 0];
    Object.defineProperty(indexes, '0', {
      configurable: true,
      enumerable: true,
      get() {
        indexes.length = 1;
        return 1;
      },
    });

    expect(() => ledger.synchronizeWorker(
      worker,
      indexes as readonly number[],
    )).toThrow(/segment index at position 1 must be a non-negative safe integer/);
    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([0]);
  });

  it('rejects malformed and unknown indexes without changing prior residency', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const worker = workerId('worker-a');
    ledger.synchronizeWorker(worker, [0]);

    expect(() => ledger.synchronizeWorker(
      worker,
      [Symbol('bad-index')] as unknown as readonly number[],
    )).toThrow(/segment index at position 0 must be a non-negative safe integer/);
    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([0]);

    expect(() => ledger.synchronizeWorker(worker, [99])).toThrow(/unknown segment 99/);
    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([0]);
  });

  it('rejects non-array inventory and preserves empty-array clearing behavior', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const worker = workerId('worker-a');

    expect(() => ledger.synchronizeWorker(
      worker,
      { 0: 0, length: 1 } as unknown as readonly number[],
    )).toThrow(/worker segmentIndexes must be an array/);

    ledger.synchronizeWorker(worker, [0, 1]);
    expect(ledger.synchronizeWorker(worker, []).residentSegmentIndexes).toEqual([]);
    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([]);
  });
});
