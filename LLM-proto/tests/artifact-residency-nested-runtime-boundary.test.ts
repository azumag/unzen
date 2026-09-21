import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact, SegmentArtifactComponent } from '../src/model-manifest.js';
import type { SegmentConfig } from '../src/types.js';

const GRAPH_LOCATOR = 'https://cdn.unzen.local/models/test/segment-0.onnx';

function makeComponent(): SegmentArtifactComponent {
  return {
    role: 'graph',
    path: 'segment-0.onnx',
    byteSize: 100,
    sha256: '1'.repeat(64),
    contentType: 'application/onnx',
    artifactLocator: GRAPH_LOCATOR,
  };
}

function makeArtifact(): SegmentArtifact {
  return {
    index: 0,
    layerStart: 0,
    layerEnd: 3,
    byteSize: 100,
    sha256: 'a'.repeat(64),
    contentType: 'application/vnd.unzen.onnx-segment-bundle',
    artifactLocator: GRAPH_LOCATOR,
    components: [makeComponent()],
    estimatedMemoryMB: 512,
    memoryBasis: 'measured',
    measurementConditions: 'nested runtime boundary fixture',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  };
}

function makeSegmentConfig(): SegmentConfig {
  const artifact = makeArtifact();
  return {
    index: artifact.index,
    layerStart: artifact.layerStart,
    layerEnd: artifact.layerEnd,
    modelWeightHash: artifact.sha256,
    estimatedVramMB: artifact.estimatedMemoryMB,
  };
}

const hostileThrownValue = {
  toString(): string {
    throw new Error('hostile thrown value must not be stringified');
  },
  [Symbol.toPrimitive](): never {
    throw new Error('hostile thrown value must not be coerced');
  },
};

function throwingField<T extends object>(value: T, field: PropertyKey): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      if (property === field) {
        throw hostileThrownValue;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function throwingArray<T>(values: T[], property: PropertyKey): readonly T[] {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (key === property) {
        throw hostileThrownValue;
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

describe('ArtifactResidencyLedger nested runtime boundary', () => {
  it('fails closed on revoked artifact, config, and component records', () => {
    const revokedArtifact = Proxy.revocable(makeArtifact(), {});
    revokedArtifact.revoke();
    expect(() => new ArtifactResidencyLedger([
      revokedArtifact.proxy as unknown as SegmentArtifact,
    ])).toThrow(/segment artifact 0 must be an object/);

    const ledger = new ArtifactResidencyLedger([makeArtifact()]);
    const revokedConfig = Proxy.revocable(makeSegmentConfig(), {});
    revokedConfig.revoke();
    expect(() => ledger.assertCompatibleSegments([
      revokedConfig.proxy as unknown as SegmentConfig,
    ])).toThrow(/segment config 0 must be an object/);

    const revokedComponent = Proxy.revocable(makeComponent(), {});
    revokedComponent.revoke();
    expect(() => new ArtifactResidencyLedger([{
      ...makeArtifact(),
      components: [revokedComponent.proxy as unknown as SegmentArtifactComponent],
    }])).toThrow(/segment 0 component 0 must be an object/);
  });

  it('maps throwing artifact field getters to stable validation diagnostics', () => {
    const cases: Array<{ field: keyof SegmentArtifact; pattern: RegExp }> = [
      { field: 'index', pattern: /segment artifact 0 index must be a non-negative safe integer/ },
      { field: 'layerStart', pattern: /segment 0 layerStart must be a non-negative safe integer/ },
      { field: 'layerEnd', pattern: /segment 0 layerEnd must be a safe integer/ },
      { field: 'byteSize', pattern: /segment 0 byteSize must be a safe positive integer/ },
      { field: 'sha256', pattern: /segment 0 sha256 must be exactly 64 lowercase hexadecimal characters/ },
      { field: 'contentType', pattern: /segment 0 contentType must be non-empty/ },
      { field: 'encoding', pattern: /segment 0 encoding must be a string when present/ },
      { field: 'artifactLocator', pattern: /segment 0 artifactLocator must be non-empty/ },
      { field: 'components', pattern: /segment 0 components must be an array when present/ },
      { field: 'estimatedMemoryMB', pattern: /segment 0 estimatedMemoryMB must be a positive finite number/ },
      { field: 'memoryBasis', pattern: /segment 0 memoryBasis must be measured, budgeted, or estimated/ },
      { field: 'measurementConditions', pattern: /segment 0 measurementConditions must be a string when present/ },
      { field: 'compatibleRuntimes', pattern: /segment 0 compatibleRuntimes must be a non-empty string array/ },
      { field: 'minimumRuntimeVersion', pattern: /segment 0 minimumRuntimeVersion must be non-empty/ },
    ];

    for (const { field, pattern } of cases) {
      expect(() => new ArtifactResidencyLedger([
        throwingField(makeArtifact(), field),
      ])).toThrow(pattern);
    }
  });

  it('maps throwing config field getters to stable validation diagnostics', () => {
    const ledger = new ArtifactResidencyLedger([makeArtifact()]);
    const cases: Array<{ field: keyof SegmentConfig; pattern: RegExp }> = [
      { field: 'index', pattern: /segment config 0 index must be a non-negative safe integer/ },
      { field: 'layerStart', pattern: /segment config 0 layerStart must be a non-negative safe integer/ },
      { field: 'layerEnd', pattern: /segment config 0 layerEnd must be a safe integer/ },
      { field: 'modelWeightHash', pattern: /segment config 0 modelWeightHash must be a non-empty string/ },
      { field: 'estimatedVramMB', pattern: /segment config 0 estimatedVramMB must be a positive finite number/ },
    ];

    for (const { field, pattern } of cases) {
      expect(() => ledger.assertCompatibleSegments([
        throwingField(makeSegmentConfig(), field),
      ])).toThrow(pattern);
    }
  });

  it('maps throwing component field getters to stable validation diagnostics', () => {
    const cases: Array<{ field: keyof SegmentArtifactComponent; pattern: RegExp }> = [
      { field: 'role', pattern: /component 0 role must be graph or external-data/ },
      { field: 'path', pattern: /component 0 path must be non-empty/ },
      { field: 'byteSize', pattern: /component 0 byteSize must be a safe positive integer/ },
      { field: 'sha256', pattern: /component 0 sha256 must be exactly 64 lowercase hexadecimal characters/ },
      { field: 'contentType', pattern: /component 0 contentType must be non-empty/ },
      { field: 'artifactLocator', pattern: /component 0 artifactLocator must be non-empty/ },
    ];

    for (const { field, pattern } of cases) {
      expect(() => new ArtifactResidencyLedger([{
        ...makeArtifact(),
        components: [throwingField(makeComponent(), field)],
      }])).toThrow(pattern);
    }
  });

  it('bounds hostile components and compatibleRuntimes arrays without caller iteration', () => {
    expect(() => new ArtifactResidencyLedger([{
      ...makeArtifact(),
      components: throwingArray([makeComponent()], 'length') as readonly SegmentArtifactComponent[],
    }])).toThrow(/segment 0 components must be an array when present/);

    expect(() => new ArtifactResidencyLedger([{
      ...makeArtifact(),
      components: throwingArray([makeComponent()], '0') as readonly SegmentArtifactComponent[],
    }])).toThrow(/segment 0 component 0 must be an object/);

    expect(() => new ArtifactResidencyLedger([{
      ...makeArtifact(),
      compatibleRuntimes: throwingArray(['onnxruntime-web'], 'length') as readonly string[],
    }])).toThrow(/segment 0 compatibleRuntimes must be a non-empty string array/);

    expect(() => new ArtifactResidencyLedger([{
      ...makeArtifact(),
      compatibleRuntimes: throwingArray(['onnxruntime-web'], '0') as readonly string[],
    }])).toThrow(/segment 0 compatibleRuntimes must be a non-empty string array/);

    let componentIteratorReads = 0;
    const components = new Proxy([makeComponent()], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          componentIteratorReads += 1;
          throw new Error('component iterator must not run');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let runtimeIteratorReads = 0;
    const compatibleRuntimes = new Proxy(['onnxruntime-web'], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          runtimeIteratorReads += 1;
          throw new Error('runtime iterator must not run');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => new ArtifactResidencyLedger([{
      ...makeArtifact(),
      components,
      compatibleRuntimes,
    }])).not.toThrow();
    expect(componentIteratorReads).toBe(0);
    expect(runtimeIteratorReads).toBe(0);
  });

  it('reads successful caller-owned fields and nested array slots at most once', () => {
    const artifactReads = new Map<PropertyKey, number>();
    const componentReads = new Map<PropertyKey, number>();
    const componentsReads = new Map<PropertyKey, number>();
    const runtimeReads = new Map<PropertyKey, number>();

    const component = new Proxy(makeComponent(), {
      get(target, property, receiver) {
        componentReads.set(property, (componentReads.get(property) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      },
    });
    const components = new Proxy([component], {
      get(target, property, receiver) {
        if (property === 'length' || property === '0') {
          componentsReads.set(property, (componentsReads.get(property) ?? 0) + 1);
        }
        if (property === Symbol.iterator) {
          throw new Error('component iterator must not run');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const compatibleRuntimes = new Proxy(['onnxruntime-web'], {
      get(target, property, receiver) {
        if (property === 'length' || property === '0') {
          runtimeReads.set(property, (runtimeReads.get(property) ?? 0) + 1);
        }
        if (property === Symbol.iterator) {
          throw new Error('runtime iterator must not run');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const artifact = new Proxy({
      ...makeArtifact(),
      components,
      compatibleRuntimes,
    }, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          artifactReads.set(property, (artifactReads.get(property) ?? 0) + 1);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const ledger = new ArtifactResidencyLedger([artifact]);
    expect(ledger.getArtifact(0).components?.[0].path).toBe('segment-0.onnx');

    for (const field of [
      'index',
      'layerStart',
      'layerEnd',
      'byteSize',
      'sha256',
      'contentType',
      'encoding',
      'artifactLocator',
      'components',
      'estimatedMemoryMB',
      'memoryBasis',
      'measurementConditions',
      'compatibleRuntimes',
      'minimumRuntimeVersion',
    ]) {
      expect(artifactReads.get(field), field).toBe(1);
    }
    for (const field of ['role', 'path', 'byteSize', 'sha256', 'contentType', 'artifactLocator']) {
      expect(componentReads.get(field), field).toBe(1);
    }
    expect(componentsReads.get('length')).toBe(1);
    expect(componentsReads.get('0')).toBe(1);
    expect(runtimeReads.get('length')).toBe(1);
    expect(runtimeReads.get('0')).toBe(1);
  });
});
