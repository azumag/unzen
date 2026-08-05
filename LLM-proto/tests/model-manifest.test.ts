import { describe, expect, it } from 'vitest';
import {
  computeModelManifestDigest,
  parseQuantizationBits,
  segmentConfigsFromManifest,
} from '../src/model-manifest.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';

describe('SegmentedModelManifest', () => {
  it('derives SegmentConfig from manifest artifacts (issue #102)', () => {
    const manifest = createFixtureModelManifest();
    const configs = segmentConfigsFromManifest(manifest);

    expect(configs).toHaveLength(manifest.segments.length);
    expect(configs[0]).toEqual({
      index: 0,
      layerStart: 0,
      layerEnd: 7,
      modelWeightHash: manifest.segments[0].sha256,
      estimatedVramMB: manifest.segments[0].estimatedMemoryMB,
    });
    // Layer ranges cover the declared totalLayers without gaps.
    expect(configs.at(-1)?.layerEnd).toBe(manifest.totalLayers - 1);
  });

  it('parses quantization strings into bit widths', () => {
    expect(parseQuantizationBits('q4')).toBe(4);
    expect(parseQuantizationBits('q8')).toBe(8);
    expect(parseQuantizationBits('fp16')).toBe(16);
    expect(parseQuantizationBits('int8')).toBe(8);
    expect(parseQuantizationBits('bf16')).toBe(16);
    expect(Number.isNaN(parseQuantizationBits('4bit'))).toBe(true);
  });

  it('computes a deterministic SHA-256 digest over the canonical manifest fields', async () => {
    const manifest = createFixtureModelManifest();
    const digest = await computeModelManifestDigest(manifest);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await computeModelManifestDigest(manifest)).toBe(digest);
  });

  it('keeps the digest stable when only the signature field differs', async () => {
    const a = createFixtureModelManifest();
    const b = { ...createFixtureModelManifest(), signature: 'signature-v1' };

    expect(await computeModelManifestDigest(a)).toBe(await computeModelManifestDigest(b));
  });
});
