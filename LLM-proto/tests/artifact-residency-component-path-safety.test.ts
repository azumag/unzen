import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact, SegmentArtifactComponent } from '../src/model-manifest.js';

function makeComponents(externalPath = 'weights/chunk-0.bin'): SegmentArtifactComponent[] {
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
      path: externalPath,
      byteSize: 200,
      sha256: '2'.repeat(64),
      contentType: 'application/octet-stream',
      artifactLocator: 'https://cdn.unzen.local/models/test/weights/chunk-0.bin',
    },
  ];
}

function makeArtifact(components: readonly SegmentArtifactComponent[]): SegmentArtifact {
  return {
    index: 0,
    layerStart: 0,
    layerEnd: 3,
    byteSize: 300,
    sha256: 'a'.repeat(64),
    contentType: 'application/vnd.unzen.onnx-segment-bundle',
    artifactLocator: 'https://cdn.unzen.local/models/test/segment0.onnx',
    components,
    estimatedMemoryMB: 512,
    memoryBasis: 'measured',
    measurementConditions: 'component path safety fixture',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  };
}

describe('ArtifactResidencyLedger component path safety', () => {
  it('accepts a nested safe relative POSIX component path', () => {
    const ledger = new ArtifactResidencyLedger([makeArtifact(makeComponents())]);

    expect(ledger.getArtifact(0).components?.[1].path).toBe('weights/chunk-0.bin');
  });

  it.each([
    '../weights.bin',
    '/weights.bin',
    'weights\\chunk.bin',
    './weights.bin',
    'weights//chunk.bin',
    'weights/../chunk.bin',
  ])('rejects unsafe direct-constructor component path %s', (path) => {
    expect(() => new ArtifactResidencyLedger([makeArtifact(makeComponents(path))]))
      .toThrow(/safe relative POSIX path/);
  });

  it('runs canonical path validation on the owned component snapshot', () => {
    let pathReads = 0;
    const graph = makeComponents()[0];
    const externalBase = makeComponents()[1];
    const external = Object.defineProperty(
      { ...externalBase },
      'path',
      {
        enumerable: true,
        get() {
          pathReads += 1;
          return pathReads === 1 ? 'weights/chunk-0.bin' : '../late-change.bin';
        },
      },
    ) as SegmentArtifactComponent;

    const ledger = new ArtifactResidencyLedger([makeArtifact([graph, external])]);

    expect(pathReads).toBe(1);
    expect(ledger.getArtifact(0).components?.[1].path).toBe('weights/chunk-0.bin');
  });
});
