import { describe, expect, it } from 'vitest';
import {
  importGeneratedOnnxSplitManifest,
  type GeneratedOnnxManifestImportOptions,
} from '../src/generated-onnx-manifest-import.js';

const baseOptions: GeneratedOnnxManifestImportOptions = {
  modelId: 'meta-llama/Llama-3.2-1B-Instruct',
  modelRevision: 'options-envelope-test',
  architecture: 'LlamaForCausalLM',
  parameterCount: 1_000_000_000,
  quantization: 'q4',
  tokenizer: 'meta-llama/Llama-3.2-1B-Instruct',
  checkpointFormat: 'onnx-hidden-state-v1',
  artifactBaseUrl: 'https://cdn.unzen.local/models/llama-1b/options-envelope-test/',
  estimatedMemoryMB: 512,
  memoryBasis: 'measured',
  measurementConditions: 'test fixture',
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
    ],
  };
}

async function expectOptionError(
  options: unknown,
  pattern: RegExp,
): Promise<void> {
  await expect(
    importGeneratedOnnxSplitManifest(generatedManifest(), options as never),
  ).rejects.toThrow(pattern);
}

describe('generated ONNX import options runtime envelope', () => {
  it.each([
    null,
    undefined,
    42,
    true,
    'options',
    [],
    Symbol('options'),
    () => undefined,
  ])('rejects malformed top-level options %p before input parsing', async (options) => {
    await expect(
      importGeneratedOnnxSplitManifest(null, options as never),
    ).rejects.toThrow(/options must be an object/);
  });

  it('rejects a coercion-sensitive artifactBaseUrl before URL parsing', async () => {
    await expectOptionError(
      { ...baseOptions, artifactBaseUrl: Symbol('url') } as never,
      /artifactBaseUrl must be a string/,
    );
  });

  it.each(['unknown', 1, null, Symbol('basis')])(
    'rejects malformed memoryBasis %p',
    async (memoryBasis) => {
      await expectOptionError(
        { ...baseOptions, memoryBasis } as never,
        /memoryBasis must be 'measured', 'budgeted', or 'estimated'/,
      );
    },
  );

  it('rejects non-string measurementConditions when present', async () => {
    await expectOptionError(
      { ...baseOptions, measurementConditions: 7 } as never,
      /measurementConditions must be a string when present/,
    );
  });

  it.each([
    null,
    undefined,
    42,
    true,
    [],
    Symbol('requirements'),
  ])('rejects malformed runtimeRequirements %p before spread/access', async (runtimeRequirements) => {
    await expectOptionError(
      { ...baseOptions, runtimeRequirements } as never,
      /runtimeRequirements must be an object/,
    );
  });

  it.each([
    -1,
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '768',
    Symbol('vram'),
  ])('rejects malformed minimumVramMB %p', async (minimumVramMB) => {
    await expectOptionError(
      {
        ...baseOptions,
        runtimeRequirements: {
          ...baseOptions.runtimeRequirements,
          minimumVramMB,
        },
      } as never,
      /runtimeRequirements\.minimumVramMB must be a positive finite number/,
    );
  });

  it.each([
    [],
    [''],
    ['unknown'],
    ['q4', 4],
    'q4',
    Symbol('quantization'),
  ])('rejects malformed supportedQuantization %p', async (supportedQuantization) => {
    await expectOptionError(
      {
        ...baseOptions,
        runtimeRequirements: {
          ...baseOptions.runtimeRequirements,
          supportedQuantization,
        },
      } as never,
      /runtimeRequirements\.supportedQuantization must be a non-empty array of quantization strings/,
    );
  });

  it.each(['minimumRuntimeVersion', 'minimumChromeVersion'] as const)(
    'rejects malformed runtimeRequirements.%s',
    async (field) => {
      await expectOptionError(
        {
          ...baseOptions,
          runtimeRequirements: {
            ...baseOptions.runtimeRequirements,
            [field]: Symbol(field),
          },
        } as never,
        new RegExp(`runtimeRequirements\\.${field} must be a non-empty string`),
      );
    },
  );

  it.each([
    null,
    undefined,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '512',
    [],
    [512, 0],
    [512, Symbol('memory')],
  ])('rejects malformed estimatedMemoryMB %p before manifest construction', async (estimatedMemoryMB) => {
    await expectOptionError(
      { ...baseOptions, estimatedMemoryMB } as never,
      /estimatedMemoryMB/,
    );
  });

  it('preserves valid import behavior after the options preflight', async () => {
    const manifest = await importGeneratedOnnxSplitManifest(
      generatedManifest(),
      baseOptions,
    );

    expect(manifest).toMatchObject({
      modelId: baseOptions.modelId,
      modelRevision: baseOptions.modelRevision,
      totalLayers: 2,
      source: 'fixture',
    });
    expect(manifest.segments[0]).toMatchObject({
      index: 0,
      byteSize: 300,
      estimatedMemoryMB: 512,
      memoryBasis: 'measured',
      measurementConditions: 'test fixture',
    });
  });
});
