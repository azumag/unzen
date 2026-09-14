import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact, SegmentArtifactComponent } from '../src/model-manifest.js';

const GRAPH_LOCATOR = 'https://cdn.unzen.local/models/test/segment-0.onnx';

function makeGraphComponent(overrides: Partial<SegmentArtifactComponent> = {}): SegmentArtifactComponent {
  return {
    role: 'graph',
    path: 'segment-0.onnx',
    byteSize: 100,
    sha256: '1'.repeat(64),
    contentType: 'application/onnx',
    artifactLocator: GRAPH_LOCATOR,
    ...overrides,
  };
}

function makeBundleArtifact(
  components: readonly SegmentArtifactComponent[],
  byteSize = 100,
): SegmentArtifact {
  return {
    index: 0,
    layerStart: 0,
    layerEnd: 3,
    byteSize,
    sha256: 'a'.repeat(64),
    contentType: 'application/vnd.unzen.onnx-segment-bundle',
    artifactLocator: GRAPH_LOCATOR,
    components,
    estimatedMemoryMB: 512,
    memoryBasis: 'measured',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  };
}

describe('ArtifactResidencyLedger component ownership', () => {
  it('captures each consumed component field once and stores only validated values', () => {
    const stable: Record<string, unknown> = {
      role: 'graph',
      path: 'segment-0.onnx',
      byteSize: 100,
      sha256: '1'.repeat(64),
      contentType: 'application/onnx',
      artifactLocator: GRAPH_LOCATOR,
    };
    const altered: Record<string, unknown> = {
      role: 'external-data',
      path: '../changed.bin',
      byteSize: 999,
      sha256: 'f'.repeat(64),
      contentType: 'application/octet-stream',
      artifactLocator: 'https://example.invalid/changed.bin',
    };
    const reads: Record<string, number> = {};
    const runtimeComponent: Record<string, unknown> = {};

    for (const field of Object.keys(stable)) {
      Object.defineProperty(runtimeComponent, field, {
        configurable: true,
        enumerable: true,
        get() {
          reads[field] = (reads[field] ?? 0) + 1;
          return reads[field] === 1 ? stable[field] : altered[field];
        },
      });
    }

    const stored = new ArtifactResidencyLedger([
      makeBundleArtifact([
        runtimeComponent as unknown as SegmentArtifactComponent,
      ]),
    ]).getArtifact(0);

    expect(stored.components).toEqual([stable]);
    expect(Object.isFrozen(stored.components)).toBe(true);
    expect(Object.isFrozen(stored.components?.[0])).toBe(true);
    for (const field of Object.keys(stable)) {
      expect(reads[field], field).toBe(1);
    }
  });

  it('fixes component-array membership before element getters run', () => {
    const components: SegmentArtifactComponent[] = [
      makeGraphComponent(),
      {
        role: 'external-data',
        path: 'invalid-late.bin',
        byteSize: 0,
        sha256: '2'.repeat(64),
        contentType: 'application/octet-stream',
        artifactLocator: 'https://cdn.unzen.local/models/test/invalid-late.bin',
      },
    ];
    Object.defineProperty(components, '0', {
      configurable: true,
      enumerable: true,
      get() {
        components.length = 1;
        return makeGraphComponent();
      },
    });

    expect(() => new ArtifactResidencyLedger([
      makeBundleArtifact(components, 100),
    ])).toThrow(/component 1 must be an object/);
  });

  it('does not reread or coerce a component byteSize after validation', () => {
    let byteSizeReads = 0;
    const hostile = {
      [Symbol.toPrimitive]() {
        throw new Error('coercion hook must not run');
      },
    };
    const component = {
      ...makeGraphComponent(),
      get byteSize() {
        byteSizeReads += 1;
        return byteSizeReads === 1 ? 100 : hostile;
      },
    } as unknown as SegmentArtifactComponent;

    const ledger = new ArtifactResidencyLedger([
      makeBundleArtifact([component]),
    ]);

    expect(ledger.getArtifact(0).components?.[0].byteSize).toBe(100);
    expect(byteSizeReads).toBe(1);
  });
});
