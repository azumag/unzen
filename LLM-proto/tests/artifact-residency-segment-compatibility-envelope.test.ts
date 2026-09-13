import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { workerId, type SegmentConfig } from '../src/types.js';

function makeArtifacts(): SegmentArtifact[] {
  return [0, 1].map((index) => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize: 100 + index * 100,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/model/segment-${index}.onnx`,
    estimatedMemoryMB: 512 + index * 128,
    memoryBasis: 'measured',
    measurementConditions: 'test fixture',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  }));
}

function makeSegments(artifacts = makeArtifacts()): SegmentConfig[] {
  return artifacts.map((artifact) => ({
    index: artifact.index,
    layerStart: artifact.layerStart,
    layerEnd: artifact.layerEnd,
    modelWeightHash: artifact.sha256,
    estimatedVramMB: artifact.estimatedMemoryMB,
  }));
}

function assertCompatibility(ledger: ArtifactResidencyLedger, value: unknown): () => void {
  return () => ledger.assertCompatibleSegments(value as readonly SegmentConfig[]);
}

describe('ArtifactResidencyLedger segment compatibility runtime envelope', () => {
  it.each([
    null,
    undefined,
    42,
    'segments',
    true,
    Symbol('segments'),
    {},
  ])('rejects malformed top-level containers before array operations', (segments) => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    expect(assertCompatibility(ledger, segments)).toThrow(/segment configs must be an array/);
  });

  it.each([
    [[null, makeSegments()[1]], /segment config 0 must be an object/],
    [[[], makeSegments()[1]], /segment config 0 must be an object/],
    [[Symbol('segment'), makeSegments()[1]], /segment config 0 must be an object/],
    [
      [{ ...makeSegments()[0], index: '0' }, makeSegments()[1]],
      /index must be a non-negative safe integer/,
    ],
    [
      [{ ...makeSegments()[0], index: Number.MAX_SAFE_INTEGER + 1 }, makeSegments()[1]],
      /index must be a non-negative safe integer/,
    ],
    [
      [{ ...makeSegments()[0], layerStart: '0' }, makeSegments()[1]],
      /layerStart must be a non-negative safe integer/,
    ],
    [
      [{ ...makeSegments()[0], layerEnd: -1 }, makeSegments()[1]],
      /layerEnd must be a safe integer greater than or equal to layerStart/,
    ],
    [
      [{ ...makeSegments()[0], modelWeightHash: Symbol('hash') }, makeSegments()[1]],
      /modelWeightHash must be a non-empty string/,
    ],
    [
      [{ ...makeSegments()[0], modelWeightHash: '   ' }, makeSegments()[1]],
      /modelWeightHash must be a non-empty string/,
    ],
    [
      [{ ...makeSegments()[0], estimatedVramMB: '512' }, makeSegments()[1]],
      /estimatedVramMB must be a positive finite number/,
    ],
    [
      [{ ...makeSegments()[0], estimatedVramMB: Number.NaN }, makeSegments()[1]],
      /estimatedVramMB must be a positive finite number/,
    ],
    [
      [{ ...makeSegments()[0], estimatedVramMB: 0 }, makeSegments()[1]],
      /estimatedVramMB must be a positive finite number/,
    ],
  ] as const)('rejects malformed segment fields deterministically', (segments, pattern) => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts());
    expect(assertCompatibility(ledger, segments)).toThrow(pattern);
  });

  it('preserves existing compatibility and mismatch semantics', () => {
    const artifacts = makeArtifacts();
    const ledger = new ArtifactResidencyLedger(artifacts);
    const segments = makeSegments(artifacts);

    expect(() => ledger.assertCompatibleSegments(segments)).not.toThrow();
    expect(() => ledger.assertCompatibleSegments([
      { ...segments[0], modelWeightHash: segments[0].modelWeightHash.toUpperCase() },
      segments[1],
    ])).not.toThrow();
    expect(() => ledger.assertCompatibleSegments([
      { ...segments[0], modelWeightHash: 'f'.repeat(64) },
      segments[1],
    ])).toThrow(/hash does not match artifact inventory/);
    expect(() => ledger.assertCompatibleSegments([
      { ...segments[0], layerEnd: segments[0].layerEnd + 1 },
      segments[1],
    ])).toThrow(/layer range .* does not match artifact range/);
    expect(() => ledger.assertCompatibleSegments([
      { ...segments[0], estimatedVramMB: segments[0].estimatedVramMB + 1 },
      segments[1],
    ])).toThrow(/does not match artifact estimate/);
  });

  it('preserves residency state when compatibility validation rejects input', () => {
    const artifacts = makeArtifacts();
    const ledger = new ArtifactResidencyLedger(artifacts);
    const worker = workerId('compatibility-worker');
    ledger.synchronizeWorker(worker, [0]);
    const before = ledger.snapshot(worker);

    const malformed = makeSegments(artifacts);
    (malformed[0] as unknown as { modelWeightHash: unknown }).modelWeightHash = Symbol('hash');
    expect(assertCompatibility(ledger, malformed)).toThrow(/modelWeightHash/);

    expect(ledger.snapshot(worker)).toEqual(before);
  });

  it('retains missing-index and count mismatch behavior after runtime validation', () => {
    const artifacts = makeArtifacts();
    const ledger = new ArtifactResidencyLedger(artifacts);
    const segments = makeSegments(artifacts);

    expect(() => ledger.assertCompatibleSegments([segments[0]])).toThrow(/config count 1/);
    expect(() => ledger.assertCompatibleSegments([
      { ...segments[0], index: 1 },
      { ...segments[1], index: 1 },
    ])).toThrow(/segment config 0 is missing/);
  });
});
