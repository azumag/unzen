import { describe, expect, it } from 'vitest';
import {
  ArtifactResidencyLedger,
  type WorkerArtifactResidencySnapshot,
} from '../src/artifact-residency-ledger.js';
import type {
  SegmentArtifact,
  SegmentedModelManifest,
} from '../src/model-manifest.js';
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
    measurementConditions: 'test fixture',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  }));
}

function makeSegmentConfigs(artifacts: readonly SegmentArtifact[]): SegmentConfig[] {
  return artifacts.map((artifact) => ({
    index: artifact.index,
    layerStart: artifact.layerStart,
    layerEnd: artifact.layerEnd,
    modelWeightHash: artifact.sha256,
    estimatedVramMB: artifact.estimatedMemoryMB,
  }));
}

function expectSnapshot(
  snapshot: WorkerArtifactResidencySnapshot,
  indexes: readonly number[],
  residentBytes: number,
): void {
  expect(snapshot.residentSegmentIndexes).toEqual(indexes);
  expect(snapshot.residentArtifactBytes).toBe(residentBytes);
}

describe('ArtifactResidencyLedger', () => {
  it('tracks exact graph-plus-external-data bytes and contiguous resident prefixes', () => {
    const artifacts = makeArtifacts([100, 250, 400, 800]);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const worker = workerId('browser-a');

    expect(ledger.totalArtifactBytes).toBe(1_550);
    expectSnapshot(ledger.synchronizeWorker(worker, [0, 1, 3]), [0, 1, 3], 1_150);
    expect(ledger.residentPrefixLength(worker, 0)).toBe(2);
    expect(ledger.residentPrefixLength(worker, 1)).toBe(1);
    expect(ledger.residentPrefixLength(worker, 2)).toBe(0);
    expect(ledger.missingArtifactBytes(worker, 0, 3)).toBe(400);
    expect(ledger.missingArtifacts(worker, 0, 3).map((artifact) => artifact.index)).toEqual([2]);
  });

  it('treats heartbeat cache contents as authoritative and removes stale entries', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts([100, 200, 300]));
    const worker = workerId('browser-b');

    ledger.synchronizeWorker(worker, [0, 1]);
    expectSnapshot(ledger.synchronizeWorker(worker, [2]), [2], 300);
    expect(ledger.isResident(worker, 0)).toBe(false);
    expect(ledger.isResident(worker, 2)).toBe(true);
  });

  it('rejects an invalid synchronization atomically', () => {
    const ledger = new ArtifactResidencyLedger(makeArtifacts([100, 200]));
    const worker = workerId('browser-c');
    ledger.synchronizeWorker(worker, [0]);

    expect(() => ledger.synchronizeWorker(worker, [1, 99])).toThrow(/unknown segment 99/);
    expectSnapshot(ledger.snapshot(worker), [0], 100);
  });

  it('validates that runtime SegmentConfig geometry matches the artifact inventory', () => {
    const artifacts = makeArtifacts([100, 200]);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const segments = makeSegmentConfigs(artifacts);

    expect(() => ledger.assertCompatibleSegments(segments)).not.toThrow();
    expect(() => ledger.assertCompatibleSegments([
      segments[0],
      { ...segments[1], modelWeightHash: 'f'.repeat(64) },
    ])).toThrow(/hash does not match/);
  });

  it('can be initialized directly from a structurally valid model manifest', () => {
    const artifacts = makeArtifacts([100, 200]);
    const manifest: SegmentedModelManifest = {
      schemaVersion: '1.0.0',
      modelId: 'test/model',
      modelRevision: 'revision-1',
      architecture: 'LlamaForCausalLM',
      parameterCount: 1_000_000,
      quantization: 'q4',
      totalLayers: 8,
      tokenizer: 'test/tokenizer',
      segments: artifacts,
      checkpointFormat: 'onnx-hidden-state-v1',
      runtimeRequirements: {
        minimumVramMB: 512,
        supportedQuantization: ['q4'],
        minimumRuntimeVersion: '1.20.0',
        minimumChromeVersion: '128',
      },
      manifestDigest: 'a'.repeat(64),
      source: 'fixture',
    };

    const ledger = ArtifactResidencyLedger.fromManifest(manifest);
    expect(ledger.segmentCount).toBe(2);
    expect(ledger.totalArtifactBytes).toBe(300);
  });

  it('fails closed on duplicate indexes and unsafe byte sizes', () => {
    const artifacts = makeArtifacts([100, 200]);
    expect(() => new ArtifactResidencyLedger([artifacts[0], artifacts[0]])).toThrow(
      /segment indexes must be exactly/,
    );
    expect(() => new ArtifactResidencyLedger([
      { ...artifacts[0], byteSize: Number.MAX_SAFE_INTEGER + 1 },
    ])).toThrow(/safe positive integer/);
  });
});
