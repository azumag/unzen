import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';

function makeArtifact(overrides: Partial<SegmentArtifact> = {}): SegmentArtifact {
  return {
    index: 0,
    layerStart: 0,
    layerEnd: 3,
    byteSize: 100,
    sha256: '1'.repeat(64),
    contentType: 'application/onnx',
    artifactLocator: 'https://cdn.unzen.local/models/test/segment-0.onnx',
    estimatedMemoryMB: 512,
    memoryBasis: 'measured',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
    ...overrides,
  };
}

describe('ArtifactResidencyLedger artifact ownership', () => {
  it('captures each consumed top-level field once and stores the validated values', () => {
    let compatibleRuntimeReads = 0;
    const compatibleRuntimes: unknown[] = [];
    Object.defineProperty(compatibleRuntimes, '0', {
      configurable: true,
      enumerable: true,
      get() {
        compatibleRuntimeReads += 1;
        return compatibleRuntimeReads === 1 ? 'onnxruntime-web' : 'altered-runtime';
      },
    });

    const stable: Record<string, unknown> = {
      index: 0,
      layerStart: 0,
      layerEnd: 3,
      byteSize: 100,
      sha256: '1'.repeat(64),
      contentType: 'application/onnx',
      encoding: 'identity',
      artifactLocator: 'https://cdn.unzen.local/models/test/segment-0.onnx',
      components: undefined,
      estimatedMemoryMB: 512,
      memoryBasis: 'measured',
      measurementConditions: 'ownership regression fixture',
      compatibleRuntimes,
      minimumRuntimeVersion: '1.20.0',
    };
    const altered: Record<string, unknown> = {
      index: 99,
      layerStart: 40,
      layerEnd: 400,
      byteSize: 999,
      sha256: 'f'.repeat(64),
      contentType: 'application/octet-stream',
      encoding: 'changed',
      artifactLocator: 'https://example.invalid/changed',
      components: [],
      estimatedMemoryMB: 10_000,
      memoryBasis: 'estimated',
      measurementConditions: 'changed',
      compatibleRuntimes: ['changed-runtime'],
      minimumRuntimeVersion: '99.0.0',
    };
    const reads: Record<string, number> = {};
    const runtimeArtifact: Record<string, unknown> = {};

    for (const field of Object.keys(stable)) {
      Object.defineProperty(runtimeArtifact, field, {
        configurable: true,
        enumerable: true,
        get() {
          reads[field] = (reads[field] ?? 0) + 1;
          return reads[field] === 1 ? stable[field] : altered[field];
        },
      });
    }

    const ledger = new ArtifactResidencyLedger([
      runtimeArtifact as unknown as SegmentArtifact,
    ]);
    const stored = ledger.getArtifact(0);

    expect(stored).toEqual({
      index: 0,
      layerStart: 0,
      layerEnd: 3,
      byteSize: 100,
      sha256: '1'.repeat(64),
      contentType: 'application/onnx',
      encoding: 'identity',
      artifactLocator: 'https://cdn.unzen.local/models/test/segment-0.onnx',
      estimatedMemoryMB: 512,
      memoryBasis: 'measured',
      measurementConditions: 'ownership regression fixture',
      compatibleRuntimes: ['onnxruntime-web'],
      minimumRuntimeVersion: '1.20.0',
    });
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.compatibleRuntimes)).toBe(true);
    expect(compatibleRuntimeReads).toBe(1);
    for (const field of Object.keys(stable)) {
      expect(reads[field], field).toBe(1);
    }
  });

  it('keeps omitted optional fields omitted in the owned snapshot', () => {
    const stored = new ArtifactResidencyLedger([makeArtifact()]).getArtifact(0);

    expect(Object.hasOwn(stored, 'encoding')).toBe(false);
    expect(Object.hasOwn(stored, 'components')).toBe(false);
    expect(Object.hasOwn(stored, 'measurementConditions')).toBe(false);
  });

  it('fails before later accessors when an early field is invalid', () => {
    let indexReads = 0;
    let layerStartReads = 0;
    const runtimeArtifact = {
      get index() {
        indexReads += 1;
        return Symbol('bad-index');
      },
      get layerStart() {
        layerStartReads += 1;
        return 0;
      },
    };

    expect(() => new ArtifactResidencyLedger([
      runtimeArtifact as unknown as SegmentArtifact,
    ])).toThrow(/segment artifact 0 index must be a non-negative safe integer/);
    expect(indexReads).toBe(1);
    expect(layerStartReads).toBe(0);
  });

  it('does not coerce hostile byteSize values while reporting validation failure', () => {
    const hostileByteSize = {
      [Symbol.toPrimitive]() {
        throw new Error('coercion hook must not run');
      },
      toString() {
        throw new Error('toString hook must not run');
      },
    };

    expect(() => new ArtifactResidencyLedger([
      makeArtifact({ byteSize: hostileByteSize as unknown as number }),
    ])).toThrow(/byteSize must be a safe positive integer/);
  });

  it('fixes compatibleRuntimes membership before element access begins', () => {
    const runtimes: unknown[] = ['placeholder', 'must-not-disappear'];
    Object.defineProperty(runtimes, '0', {
      configurable: true,
      enumerable: true,
      get() {
        runtimes.length = 1;
        return 'onnxruntime-web';
      },
    });

    expect(() => new ArtifactResidencyLedger([
      makeArtifact({ compatibleRuntimes: runtimes as readonly string[] }),
    ])).toThrow(/compatibleRuntimes must be a non-empty string array/);
  });
});
