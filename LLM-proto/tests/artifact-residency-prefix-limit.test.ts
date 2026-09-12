import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { workerId } from '../src/types.js';

function makeArtifacts(): SegmentArtifact[] {
  return [0, 1, 2].map((index) => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize: 100,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/model/segment-${index}.onnx`,
    estimatedMemoryMB: 512,
    memoryBasis: 'measured',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  }));
}

describe('ArtifactResidencyLedger residentPrefixLength runtime limit', () => {
  it('preserves finite flooring and positive-infinity unbounded semantics', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const worker = workerId('browser-prefix-limit');
    ledger.synchronizeWorker(worker, [0, 1, 2]);

    expect(ledger.residentPrefixLength(worker, 0, 1)).toBe(1);
    expect(ledger.residentPrefixLength(worker, 0, 1.9)).toBe(1);
    expect(ledger.residentPrefixLength(worker, 0, Number.POSITIVE_INFINITY)).toBe(3);
  });

  it.each([
    ['negative', -1],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['numeric string', '1'],
    ['arbitrary string', 'unbounded'],
    ['boolean', true],
    ['symbol', Symbol('maximumLength')],
  ])('rejects malformed %s limits instead of expanding them', (_label, malformedLimit) => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    const worker = workerId('browser-prefix-limit');
    ledger.synchronizeWorker(worker, [0, 1, 2]);

    expect(() =>
      ledger.residentPrefixLength(worker, 0, malformedLimit as unknown as number),
    ).toThrow(/maximumLength must be a non-negative number/);
    expect(ledger.residentPrefixLength(worker, 0, 1)).toBe(1);
  });
});
