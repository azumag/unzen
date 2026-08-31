import { describe, expect, it } from 'vitest';
import {
  BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
  BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
} from '../src/browser-segment-artifact-budget.js';
import {
  importGeneratedOnnxSplitManifest,
  type GeneratedOnnxManifestImportOptions,
} from '../src/generated-onnx-manifest-import.js';

const options: GeneratedOnnxManifestImportOptions = {
  modelId: 'test/model',
  modelRevision: 'revision-1',
  architecture: 'LlamaForCausalLM',
  parameterCount: 1_000_000,
  quantization: 'q4',
  tokenizer: 'test/tokenizer',
  checkpointFormat: 'onnx-hidden-state-v1',
  artifactBaseUrl: 'https://cdn.unzen.local/models/revision-1/',
  estimatedMemoryMB: 512,
  memoryBasis: 'measured',
  compatibleRuntimes: ['onnxruntime-web'],
  minimumRuntimeVersion: '1.20.0',
  runtimeRequirements: {
    minimumVramMB: 512,
    supportedQuantization: ['q4'],
    minimumRuntimeVersion: '1.20.0',
    minimumChromeVersion: '128',
  },
  source: 'fixture',
};

function generated(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-budgeted-multi-segment-onnx',
    artifactLayout: 'per-segment-external-data',
    browserArtifactBudget: {
      requiredMaxBytes: BROWSER_SEGMENT_PREFERRED_MAX_BYTES,
      absoluteMaxBytes: BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
    },
    segments: [
      {
        index: 0,
        path: 'segment0.onnx',
        sha256: '1'.repeat(64),
        startLayer: 0,
        endLayer: 2,
        browserArtifactBytes: 300,
        externalData: [
          {
            location: 'segment0.onnx_data',
            bytes: 200,
            sha256: '2'.repeat(64),
          },
        ],
      },
    ],
  };
}

describe('generated ONNX import product policy', () => {
  it('does not let generated metadata relax the product preferred ceiling', async () => {
    const input = generated();
    const budget = input.browserArtifactBudget as Record<string, unknown>;
    budget.requiredMaxBytes = BROWSER_SEGMENT_PREFERRED_MAX_BYTES + 1;

    await expect(importGeneratedOnnxSplitManifest(input, options))
      .rejects.toThrow(/cannot relax the product preferred ceiling/);
  });

  it('does not let generated metadata relax the product absolute ceiling', async () => {
    const input = generated();
    const budget = input.browserArtifactBudget as Record<string, unknown>;
    budget.absoluteMaxBytes = BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES + 1;

    await expect(importGeneratedOnnxSplitManifest(input, options))
      .rejects.toThrow(/cannot relax the product absolute ceiling/);
  });

  it.each(['C:/weights.onnx', 'https:/remote.example/weights.onnx'])(
    'rejects drive or scheme-like relative path %s',
    async (path) => {
      const input = generated();
      const segments = input.segments as Record<string, unknown>[];
      segments[0].path = path;

      await expect(importGeneratedOnnxSplitManifest(input, options))
        .rejects.toThrow(/safe relative path/);
    },
  );

  it('rejects credentials in the artifact base URL', async () => {
    await expect(importGeneratedOnnxSplitManifest(
      generated(),
      {
        ...options,
        artifactBaseUrl: 'https://user:secret@cdn.unzen.local/models/revision-1/',
      },
    )).rejects.toThrow(/must not contain credentials/);
  });
});
