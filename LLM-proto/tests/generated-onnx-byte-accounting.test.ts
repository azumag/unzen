import { describe, expect, it } from 'vitest';
import {
  importGeneratedOnnxSplitManifest,
  type GeneratedOnnxManifestImportOptions,
} from '../src/generated-onnx-manifest-import.js';

const options: GeneratedOnnxManifestImportOptions = {
  modelId: 'fixture/generated-onnx-byte-accounting',
  modelRevision: 'revision-test',
  architecture: 'FixtureForCausalLM',
  parameterCount: 1_000,
  quantization: 'q4',
  tokenizer: 'fixture/tokenizer',
  checkpointFormat: 'onnx-hidden-state-v1',
  artifactBaseUrl: 'https://cdn.unzen.local/generated-byte-accounting/',
  estimatedMemoryMB: 64,
  memoryBasis: 'measured',
  compatibleRuntimes: ['onnxruntime-web'],
  minimumRuntimeVersion: '1.20.0',
  runtimeRequirements: {
    minimumVramMB: 128,
    supportedQuantization: ['q4'],
    minimumRuntimeVersion: '1.20.0',
    minimumChromeVersion: '128',
  },
  source: 'fixture',
};

function generatedSegment(externalBytes: readonly number[]): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-budgeted-multi-segment-onnx',
    artifactLayout: 'per-segment-external-data',
    browserArtifactBudget: {
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
        externalData: externalBytes.map((bytes, index) => ({
          location: `segment0-${index}.onnx_data`,
          bytes,
          sha256: String(index + 2).repeat(64),
        })),
      },
    ],
  };
}

describe('generated ONNX exact byte accounting', () => {
  it('rejects cumulative external-data bytes before the safe-integer range is exceeded', async () => {
    await expect(
      importGeneratedOnnxSplitManifest(
        generatedSegment([Number.MAX_SAFE_INTEGER, 1]),
        options,
      ),
    ).rejects.toThrow(
      'segment 0 external bytes exceeds JavaScript safe integer range',
    );
  });

  it('preserves exact graph-byte derivation for safe cumulative external-data bytes', async () => {
    const manifest = await importGeneratedOnnxSplitManifest(
      generatedSegment([100, 50]),
      options,
    );

    expect(manifest.segments[0].components?.map((component) => component.byteSize)).toEqual([
      150,
      100,
      50,
    ]);
    expect(manifest.segments[0].byteSize).toBe(300);
  });
});
