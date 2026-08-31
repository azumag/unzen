import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import {
  importGeneratedOnnxSplitManifest,
  type GeneratedOnnxManifestImportOptions,
} from '../src/generated-onnx-manifest-import.js';
import {
  computeModelManifestDigest,
  computeSegmentArtifactBundleDigest,
  segmentConfigsFromManifest,
  type SegmentedModelManifest,
} from '../src/model-manifest.js';
import {
  validateModelManifest,
  validateModelManifestShape,
} from '../src/model-manifest-validator.js';

const options: GeneratedOnnxManifestImportOptions = {
  modelId: 'meta-llama/Llama-3.2-1B-Instruct',
  modelRevision: 'revision-test',
  architecture: 'LlamaForCausalLM',
  parameterCount: 1_000_000_000,
  quantization: 'q4',
  tokenizer: 'meta-llama/Llama-3.2-1B-Instruct',
  checkpointFormat: 'onnx-hidden-state-v1',
  artifactBaseUrl: 'https://cdn.unzen.local/models/llama-1b/revision-test/',
  estimatedMemoryMB: [512, 640],
  memoryBasis: 'measured',
  measurementConditions: 'Chrome 152 / WebGPU fixture',
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

describe('importGeneratedOnnxSplitManifest', () => {
  it('converts measured graph plus external-data files into runtime bundle artifacts', async () => {
    const manifest = await importGeneratedOnnxSplitManifest(
      generatedManifest(),
      options,
    );

    expect(manifest.totalLayers).toBe(4);
    expect(manifest.segments).toHaveLength(2);
    expect(manifest.segments[0]).toMatchObject({
      index: 0,
      layerStart: 0,
      layerEnd: 1,
      byteSize: 300,
      contentType: 'application/vnd.unzen.onnx-segment-bundle',
      artifactLocator: 'https://cdn.unzen.local/models/llama-1b/revision-test/segment0.onnx',
      estimatedMemoryMB: 512,
      memoryBasis: 'measured',
    });
    expect(manifest.segments[0].components).toEqual([
      {
        role: 'graph',
        path: 'segment0.onnx',
        byteSize: 100,
        sha256: '1'.repeat(64),
        contentType: 'application/onnx',
        artifactLocator: 'https://cdn.unzen.local/models/llama-1b/revision-test/segment0.onnx',
      },
      {
        role: 'external-data',
        path: 'segment0.onnx_data',
        byteSize: 200,
        sha256: '2'.repeat(64),
        contentType: 'application/octet-stream',
        artifactLocator: 'https://cdn.unzen.local/models/llama-1b/revision-test/segment0.onnx_data',
      },
    ]);
    expect(manifest.segments[0].sha256).toBe(
      await computeSegmentArtifactBundleDigest(manifest.segments[0].components!),
    );
    expect(manifest.manifestDigest).toBe(await computeModelManifestDigest(manifest));
    expect((await validateModelManifest(manifest)).status).toBe('valid');
    expect(new ArtifactResidencyLedger(manifest.segments).totalArtifactBytes).toBe(700);
    expect(segmentConfigsFromManifest(manifest).map((segment) => segment.modelWeightHash))
      .toEqual(manifest.segments.map((segment) => segment.sha256));
  });

  it('normalizes a base URL without a trailing slash', async () => {
    const manifest = await importGeneratedOnnxSplitManifest(
      generatedManifest(),
      { ...options, artifactBaseUrl: 'https://cdn.unzen.local/models/revision-test' },
    );

    expect(manifest.segments[0].components?.[0].artifactLocator)
      .toBe('https://cdn.unzen.local/models/revision-test/segment0.onnx');
  });

  it('rejects a generated manifest without browser budget evidence', async () => {
    const input = generatedManifest();
    delete input.browserArtifactBudget;

    await expect(importGeneratedOnnxSplitManifest(input, options))
      .rejects.toThrow(/browserArtifactBudget/);
  });

  it('rejects a segment that exceeds the generated required browser ceiling', async () => {
    const input = generatedManifest();
    const budget = input.browserArtifactBudget as Record<string, unknown>;
    budget.requiredMaxBytes = 299;

    await expect(importGeneratedOnnxSplitManifest(input, options))
      .rejects.toThrow(/segment 0.*required browser budget/i);
  });

  it('rejects a bundle whose external data consumes the complete measured total', async () => {
    const input = generatedManifest();
    const segments = input.segments as Record<string, unknown>[];
    segments[0].browserArtifactBytes = 200;

    await expect(importGeneratedOnnxSplitManifest(input, options))
      .rejects.toThrow(/graph byte size must be positive/);
  });

  it.each(['../escape.onnx', '/absolute.onnx', 'nested\\windows.onnx'])(
    'rejects unsafe generated path %s',
    async (path) => {
      const input = generatedManifest();
      const segments = input.segments as Record<string, unknown>[];
      segments[0].path = path;

      await expect(importGeneratedOnnxSplitManifest(input, options))
        .rejects.toThrow(/safe relative path/);
    },
  );

  it('rejects non-contiguous generated layer ranges', async () => {
    const input = generatedManifest();
    const segments = input.segments as Record<string, unknown>[];
    segments[1].startLayer = 3;

    await expect(importGeneratedOnnxSplitManifest(input, options))
      .rejects.toThrow(/contiguous/);
  });

  it('rejects a per-segment memory list with the wrong length', async () => {
    await expect(importGeneratedOnnxSplitManifest(
      generatedManifest(),
      { ...options, estimatedMemoryMB: [512] },
    )).rejects.toThrow(/estimatedMemoryMB.*segment count/);
  });

  it('requires HTTPS for production artifact origins', async () => {
    await expect(importGeneratedOnnxSplitManifest(
      generatedManifest(),
      {
        ...options,
        source: 'production',
        artifactBaseUrl: 'http://cdn.unzen.local/models/revision-test/',
      },
    )).rejects.toThrow(/production artifactBaseUrl must use HTTPS/);
  });
});

describe('bundle component manifest validation', () => {
  it('rejects component byte totals that differ from SegmentArtifact.byteSize', async () => {
    const manifest = await importGeneratedOnnxSplitManifest(generatedManifest(), options);
    const invalid = structuredClone(manifest) as SegmentedModelManifest;
    (invalid.segments[0].components![0] as { byteSize: number }).byteSize += 1;

    const validation = validateModelManifestShape(invalid);
    expect(validation.status).toBe('invalid');
    expect(validation.issues.some((issue) => issue.code === 'artifact-component-byte-size-mismatch'))
      .toBe(true);
  });

  it('rejects a bundle digest mismatch even when the outer manifest digest is recomputed', async () => {
    const manifest = await importGeneratedOnnxSplitManifest(generatedManifest(), options);
    const invalid = structuredClone(manifest) as SegmentedModelManifest;
    (invalid.segments[0] as { sha256: string }).sha256 = 'f'.repeat(64);
    (invalid as { manifestDigest: string }).manifestDigest = await computeModelManifestDigest(invalid);

    const validation = await validateModelManifest(invalid);
    expect(validation.status).toBe('invalid');
    expect(validation.issues.some((issue) => issue.code === 'artifact-bundle-digest-mismatch'))
      .toBe(true);
  });

  it('requires the primary locator to identify the graph component', async () => {
    const manifest = await importGeneratedOnnxSplitManifest(generatedManifest(), options);
    const invalid = structuredClone(manifest) as SegmentedModelManifest;
    (invalid.segments[0] as { artifactLocator: string }).artifactLocator =
      invalid.segments[0].components![1].artifactLocator;

    const validation = validateModelManifestShape(invalid);
    expect(validation.status).toBe('invalid');
    expect(validation.issues.some((issue) => issue.code === 'artifact-primary-locator-mismatch'))
      .toBe(true);
  });
});
