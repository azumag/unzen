import { describe, expect, it } from 'vitest';
import {
  importGeneratedOnnxSplitManifest,
  type GeneratedOnnxManifestImportOptions,
} from '../src/generated-onnx-manifest-import.js';

function importOptions(): GeneratedOnnxManifestImportOptions {
  return {
    modelId: 'meta-llama/Llama-3.2-1B-Instruct',
    modelRevision: 'generated-input-snapshot',
    architecture: 'LlamaForCausalLM',
    parameterCount: 1_000_000_000,
    quantization: 'q4',
    tokenizer: 'meta-llama/Llama-3.2-1B-Instruct',
    checkpointFormat: 'onnx-hidden-state-v1',
    artifactBaseUrl: 'https://cdn.unzen.local/models/llama-1b/generated-input-snapshot/',
    estimatedMemoryMB: [512, 640],
    memoryBasis: 'measured',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
    runtimeRequirements: {
      minimumVramMB: 768,
      supportedQuantization: ['q4'],
      minimumRuntimeVersion: '1.20.0',
      minimumChromeVersion: '128',
    },
    source: 'fixture',
  };
}

function generatedManifest(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-budgeted-multi-segment-onnx',
    artifactLayout: 'per-segment-external-data',
    browserArtifactBudget: {
      requiredTier: 'preferred',
      requiredMaxBytes: 256 * 1024 * 1024,
      absoluteMaxBytes: 1024 * 1024 * 1024,
    },
    segments: [
      {
        index: 0,
        path: 'segment0.onnx',
        sha256: '1'.repeat(64),
        startLayer: 0,
        endLayer: 2,
        browserArtifactBytes: 300,
        browserArtifactTier: 'preferred',
        externalData: [
          {
            location: 'segment0.onnx_data',
            bytes: 200,
            sha256: '2'.repeat(64),
          },
        ],
      },
      {
        index: 1,
        path: 'segment1.onnx',
        sha256: '3'.repeat(64),
        startLayer: 2,
        endLayer: 4,
        browserArtifactBytes: 400,
        browserArtifactTier: 'preferred',
        externalData: [
          {
            location: 'segment1.onnx_data',
            bytes: 250,
            sha256: '4'.repeat(64),
          },
        ],
      },
    ],
  };
}

describe('generated ONNX manifest input ownership', () => {
  it('captures the root segments property exactly once', async () => {
    const input = generatedManifest();
    const stableSegments = input.segments;
    let segmentPropertyReads = 0;
    Object.defineProperty(input, 'segments', {
      configurable: true,
      enumerable: true,
      get() {
        segmentPropertyReads += 1;
        return segmentPropertyReads === 1 ? stableSegments : [];
      },
    });

    const manifest = await importGeneratedOnnxSplitManifest(input, importOptions());

    expect(segmentPropertyReads).toBe(1);
    expect(manifest.segments).toHaveLength(2);
  });

  it('parses segment membership from an owned snapshot', async () => {
    const input = generatedManifest();
    const callerSegments = input.segments as Record<string, unknown>[];
    const firstSegment = callerSegments[0];
    Object.defineProperty(firstSegment, 'index', {
      configurable: true,
      enumerable: true,
      get() {
        callerSegments[1] = { index: 999 };
        return 0;
      },
    });

    const manifest = await importGeneratedOnnxSplitManifest(input, importOptions());

    expect(manifest.segments.map((segment) => segment.index)).toEqual([0, 1]);
  });

  it('captures each segment externalData property exactly once', async () => {
    const input = generatedManifest();
    const callerSegments = input.segments as Record<string, unknown>[];
    const firstSegment = callerSegments[0];
    const stableExternalData = firstSegment.externalData;
    let externalDataReads = 0;
    Object.defineProperty(firstSegment, 'externalData', {
      configurable: true,
      enumerable: true,
      get() {
        externalDataReads += 1;
        return externalDataReads === 1
          ? stableExternalData
          : [{ location: '../escape.bin', bytes: 200, sha256: 'f'.repeat(64) }];
      },
    });

    const manifest = await importGeneratedOnnxSplitManifest(input, importOptions());

    expect(externalDataReads).toBe(1);
    expect(manifest.segments[0].components?.[1].path).toBe('segment0.onnx_data');
  });
});
