import { describe, expect, it } from 'vitest';
import {
  ArtifactResidencyLedger,
  type WorkerArtifactResidencySnapshot,
} from '../src/artifact-residency-ledger.js';
import type {
  SegmentArtifact,
  SegmentArtifactComponent,
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

function makeBundleComponents(): SegmentArtifactComponent[] {
  return [
    {
      role: 'graph',
      path: 'segment0.onnx',
      byteSize: 100,
      sha256: '1'.repeat(64),
      contentType: 'application/onnx',
      artifactLocator: 'https://cdn.unzen.local/models/test/segment0.onnx',
    },
    {
      role: 'external-data',
      path: 'segment0.onnx_data',
      byteSize: 200,
      sha256: '2'.repeat(64),
      contentType: 'application/octet-stream',
      artifactLocator: 'https://cdn.unzen.local/models/test/segment0.onnx_data',
    },
  ];
}

function makeBundleArtifact(components = makeBundleComponents()): SegmentArtifact {
  return {
    ...makeArtifacts([300])[0],
    contentType: 'application/vnd.unzen.onnx-segment-bundle',
    artifactLocator: 'https://cdn.unzen.local/models/test/segment0.onnx',
    components,
  };
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

  it('copies and freezes component bundles so caller mutation cannot rewrite inventory', () => {
    const components = makeBundleComponents();
    const ledger = new ArtifactResidencyLedger([makeBundleArtifact(components)]);

    components[0].byteSize = 999;
    components.push({
      ...components[1],
      path: 'late-added.bin',
    });

    const stored = ledger.getArtifact(0);
    expect(stored.components).toHaveLength(2);
    expect(stored.components?.[0].byteSize).toBe(100);
    expect(Object.isFrozen(stored.components)).toBe(true);
    expect(Object.isFrozen(stored.components?.[0])).toBe(true);
  });

  it('rejects a directly constructed bundle whose component bytes are inconsistent', () => {
    const artifact = makeBundleArtifact([
      {
        ...makeBundleComponents()[0],
        byteSize: 100,
      },
    ]);

    expect(() => new ArtifactResidencyLedger([artifact])).toThrow(/component bytes/);
  });

  it('fails closed on malformed direct-constructor component identity metadata', () => {
    const base = makeBundleComponents();
    const cases: Array<{ name: string; components: SegmentArtifactComponent[]; pattern: RegExp }> = [
      {
        name: 'unknown role',
        components: [{ ...base[0], role: 'weights' as SegmentArtifactComponent['role'] }, base[1]],
        pattern: /role must be graph or external-data/,
      },
      {
        name: 'empty path',
        components: [{ ...base[0], path: '   ' }, base[1]],
        pattern: /path must be non-empty/,
      },
      {
        name: 'invalid digest',
        components: [{ ...base[0], sha256: 'ABC' }, base[1]],
        pattern: /sha256 must be exactly 64 lowercase hexadecimal/,
      },
      {
        name: 'empty content type',
        components: [{ ...base[0], contentType: '   ' }, base[1]],
        pattern: /contentType must be non-empty/,
      },
      {
        name: 'empty locator',
        components: [{ ...base[0], artifactLocator: '   ' }, base[1]],
        pattern: /artifactLocator must be non-empty/,
      },
    ];

    for (const testCase of cases) {
      expect(
        () => new ArtifactResidencyLedger([makeBundleArtifact(testCase.components)]),
        testCase.name,
      ).toThrow(testCase.pattern);
    }
  });

  it('requires unique component paths and exactly one graph bound to the primary locator', () => {
    const base = makeBundleComponents();

    expect(() => new ArtifactResidencyLedger([makeBundleArtifact([
      base[0],
      { ...base[1], path: base[0].path },
    ])])).toThrow(/component path .* must be unique/);

    expect(() => new ArtifactResidencyLedger([makeBundleArtifact([
      { ...base[0], role: 'external-data' },
      base[1],
    ])])).toThrow(/exactly one graph component; found 0/);

    expect(() => new ArtifactResidencyLedger([makeBundleArtifact([
      base[0],
      { ...base[1], role: 'graph' },
    ])])).toThrow(/exactly one graph component; found 2/);

    expect(() => new ArtifactResidencyLedger([{
      ...makeBundleArtifact(base),
      artifactLocator: 'https://cdn.unzen.local/models/test/not-the-graph.onnx',
    }])).toThrow(/primary artifactLocator must match the graph component locator/);
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
