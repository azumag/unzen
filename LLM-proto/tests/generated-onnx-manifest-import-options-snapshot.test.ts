import { describe, expect, it } from 'vitest';
import {
  importGeneratedOnnxSplitManifest,
  type GeneratedOnnxManifestImportOptions,
} from '../src/generated-onnx-manifest-import.js';

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

function importOptions(): GeneratedOnnxManifestImportOptions {
  return {
    modelId: 'meta-llama/Llama-3.2-1B-Instruct',
    modelRevision: 'validated-revision',
    architecture: 'LlamaForCausalLM',
    parameterCount: 1_000_000_000,
    quantization: 'q4',
    tokenizer: 'meta-llama/Llama-3.2-1B-Instruct',
    checkpointFormat: 'onnx-hidden-state-v1',
    artifactBaseUrl: 'https://cdn.unzen.local/models/llama-1b/validated-revision/',
    estimatedMemoryMB: [512, 640],
    memoryBasis: 'measured',
    measurementConditions: 'validated conditions',
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

describe('generated ONNX import option ownership', () => {
  it('uses the validated option snapshot after async hashing begins', async () => {
    const callerOwned = importOptions();
    const importPromise = importGeneratedOnnxSplitManifest(
      generatedManifest(),
      callerOwned,
    );

    const mutable = callerOwned as unknown as {
      modelRevision: string;
      memoryBasis: string;
      measurementConditions: string;
      compatibleRuntimes: string[];
      minimumRuntimeVersion: string;
      source: string;
      runtimeRequirements: {
        minimumVramMB: number;
        supportedQuantization: string[];
        minimumRuntimeVersion: string;
        minimumChromeVersion: string;
      };
    };
    mutable.modelRevision = 'mutated-revision';
    mutable.memoryBasis = 'estimated';
    mutable.measurementConditions = 'mutated conditions';
    mutable.compatibleRuntimes[0] = 'mutated-runtime';
    mutable.minimumRuntimeVersion = '99.0.0';
    mutable.source = 'production';
    mutable.runtimeRequirements.minimumVramMB = 9_999;
    mutable.runtimeRequirements.supportedQuantization[0] = 'q8';
    mutable.runtimeRequirements.minimumRuntimeVersion = '99.0.0';
    mutable.runtimeRequirements.minimumChromeVersion = '999';

    const manifest = await importPromise;

    expect(manifest.modelRevision).toBe('validated-revision');
    expect(manifest.source).toBe('fixture');
    expect(manifest.segments.every((segment) => segment.memoryBasis === 'measured')).toBe(true);
    expect(manifest.segments.every((segment) =>
      segment.measurementConditions === 'validated conditions'
    )).toBe(true);
    expect(manifest.segments.every((segment) =>
      segment.compatibleRuntimes[0] === 'onnxruntime-web'
    )).toBe(true);
    expect(manifest.segments.every((segment) =>
      segment.minimumRuntimeVersion === '1.20.0'
    )).toBe(true);
    expect(manifest.runtimeRequirements).toEqual({
      minimumVramMB: 768,
      supportedQuantization: ['q4'],
      minimumRuntimeVersion: '1.20.0',
      minimumChromeVersion: '128',
    });
  });
});
