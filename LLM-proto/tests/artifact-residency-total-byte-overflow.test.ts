import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { workerId } from '../src/types.js';

function artifact(index: number, byteSize: number): SegmentArtifact {
  return {
    index,
    layerStart: index,
    layerEnd: index,
    byteSize,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/models/overflow/segment-${index}.onnx`,
    estimatedMemoryMB: 64,
    memoryBasis: 'measured',
    measurementConditions: 'overflow regression fixture',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  };
}

describe('ArtifactResidencyLedger total byte accounting', () => {
  it('fails closed when individually safe artifact sizes would overflow the cumulative total', () => {
    expect(() => new ArtifactResidencyLedger([
      artifact(0, Number.MAX_SAFE_INTEGER),
      artifact(1, 1),
    ])).toThrow('total artifact byte size exceeds JavaScript safe integer range');
  });

  it('preserves exact totals and residency behavior for safe inventories', () => {
    const ledger = new ArtifactResidencyLedger([
      artifact(0, 100),
      artifact(1, 250),
      artifact(2, 400),
    ]);
    const worker = workerId('browser-safe-total');

    expect(ledger.totalArtifactBytes).toBe(750);
    expect(ledger.synchronizeWorker(worker, [0, 2])).toEqual({
      workerId: worker,
      residentSegmentIndexes: [0, 2],
      residentArtifactBytes: 500,
      totalArtifactBytes: 750,
      coverageRatio: 500 / 750,
    });
    expect(ledger.missingArtifactBytes(worker, 0, 2)).toBe(250);
  });
});
