import { describe, expect, it } from 'vitest';
import {
  importGeneratedOnnxSplitManifest,
  type GeneratedOnnxManifestImportOptions,
} from '../src/generated-onnx-manifest-import.js';

const options: GeneratedOnnxManifestImportOptions = {
  modelId: 'meta-llama/Llama-3.2-1B-Instruct',
  modelRevision: 'path-identity-test',
  architecture: 'LlamaForCausalLM',
  parameterCount: 1_000_000_000,
  quantization: 'q4',
  tokenizer: 'meta-llama/Llama-3.2-1B-Instruct',
  checkpointFormat: 'onnx-hidden-state-v1',
  artifactBaseUrl: 'https://cdn.unzen.local/models/path-identity-test/',
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
        path: 'graphs/segment0.onnx',
        sha256: '1'.repeat(64),
        startLayer: 0,
        endLayer: 2,
        browserArtifactBytes: 300,
        browserArtifactTier: 'preferred',
        externalData: [{ location: 'weights/segment0.bin', bytes: 200, sha256: '2'.repeat(64) }],
      },
      {
        index: 1,
        path: 'graphs/segment1.onnx',
        sha256: '3'.repeat(64),
        startLayer: 2,
        endLayer: 4,
        browserArtifactBytes: 400,
        browserArtifactTier: 'preferred',
        externalData: [{ location: 'weights/segment1.bin', bytes: 250, sha256: '4'.repeat(64) }],
      },
    ],
  };
}

describe('generated ONNX artifact path identity', () => {
  it('rejects exact graph path reuse across segments', async () => {
    const input = generatedManifest();
    const segments = input.segments as Record<string, unknown>[];
    segments[1].path = 'graphs/segment0.onnx';
    await expect(importGeneratedOnnxSplitManifest(input, options))
      .rejects.toThrow(/artifact path graphs\/segment0\.onnx is reused by segments 0 and 1/);
  });

  it('rejects a graph path reused by external data in another segment', async () => {
    const input = generatedManifest();
    const segments = input.segments as Record<string, unknown>[];
    const externalData = segments[1].externalData as Record<string, unknown>[];
    externalData[0].location = 'graphs/segment0.onnx';
    await expect(importGeneratedOnnxSplitManifest(input, options))
      .rejects.toThrow(/artifact path graphs\/segment0\.onnx is reused by segments 0 and 1/);
  });

  it('rejects ASCII case-only aliases across segments', async () => {
    const input = generatedManifest();
    const segments = input.segments as Record<string, unknown>[];
    segments[1].path = 'GRAPHS/SEGMENT0.ONNX';
    await expect(importGeneratedOnnxSplitManifest(input, options))
      .rejects.toThrow(/portable case aliases/);
  });

  it('rejects ASCII case-only graph/external aliases within one segment', async () => {
    const input = generatedManifest();
    const segments = input.segments as Record<string, unknown>[];
    const externalData = segments[0].externalData as Record<string, unknown>[];
    externalData[0].location = 'GRAPHS/SEGMENT0.ONNX';
    await expect(importGeneratedOnnxSplitManifest(input, options))
      .rejects.toThrow(/portable case aliases/);
  });

  it('continues to accept distinct portable paths', async () => {
    await expect(importGeneratedOnnxSplitManifest(generatedManifest(), options))
      .resolves.toMatchObject({ totalLayers: 4 });
  });
});
