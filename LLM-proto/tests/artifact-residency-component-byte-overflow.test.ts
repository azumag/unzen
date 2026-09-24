import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact, SegmentArtifactComponent } from '../src/model-manifest.js';

function component(
  role: SegmentArtifactComponent['role'],
  path: string,
  byteSize: number,
  digit: string,
): SegmentArtifactComponent {
  return {
    role,
    path,
    byteSize,
    sha256: digit.repeat(64),
    contentType: role === 'graph' ? 'application/onnx' : 'application/octet-stream',
    artifactLocator: `https://cdn.unzen.local/models/component-overflow/${path}`,
  };
}

function bundle(byteSize: number, components: readonly SegmentArtifactComponent[]): SegmentArtifact {
  return {
    index: 0,
    layerStart: 0,
    layerEnd: 0,
    byteSize,
    sha256: 'a'.repeat(64),
    contentType: 'application/vnd.unzen.onnx-segment-bundle',
    artifactLocator: components[0].artifactLocator,
    components,
    estimatedMemoryMB: 64,
    memoryBasis: 'measured',
    measurementConditions: 'component overflow regression fixture',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  };
}

describe('ArtifactResidencyLedger component byte accounting', () => {
  it('fails closed before individually safe component sizes overflow the cumulative total', () => {
    const components = [
      component('graph', 'segment0.onnx', Number.MAX_SAFE_INTEGER, '1'),
      component('external-data', 'segment0.onnx_data', 1, '2'),
    ];

    expect(() => new ArtifactResidencyLedger([
      bundle(Number.MAX_SAFE_INTEGER, components),
    ])).toThrow('segment 0 component bytes exceed JavaScript safe integer range');
  });

  it('preserves exact component totals for a valid bundle', () => {
    const components = [
      component('graph', 'segment0.onnx', 100, '1'),
      component('external-data', 'segment0.onnx_data', 200, '2'),
    ];
    const ledger = new ArtifactResidencyLedger([bundle(300, components)]);

    expect(ledger.totalArtifactBytes).toBe(300);
    expect(ledger.getArtifact(0).components?.map(({ role, byteSize }) => ({ role, byteSize }))).toEqual([
      { role: 'graph', byteSize: 100 },
      { role: 'external-data', byteSize: 200 },
    ]);
  });
});
