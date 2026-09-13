import { describe, expect, it } from 'vitest';
import {
  canonicalSegmentArtifactBundleFields,
  computeModelManifestDigest,
  computeSegmentArtifactBundleDigest,
  parseQuantizationBits,
  segmentConfigsFromManifest,
  type SegmentArtifactComponent,
} from '../src/model-manifest.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';

const graphComponent: SegmentArtifactComponent = {
  role: 'graph',
  path: 'segment0.onnx',
  byteSize: 128,
  sha256: 'a'.repeat(64),
  contentType: 'application/onnx',
  artifactLocator: 'https://cdn.unzen.local/models/test/segment0.onnx',
};

const externalA: SegmentArtifactComponent = {
  role: 'external-data',
  path: 'segment0-a.onnx_data',
  byteSize: 256,
  sha256: 'b'.repeat(64),
  contentType: 'application/octet-stream',
  artifactLocator: 'https://cdn.unzen.local/models/test/segment0-a.onnx_data',
};

const externalB: SegmentArtifactComponent = {
  role: 'external-data',
  path: 'segment0-b.onnx_data',
  byteSize: 512,
  sha256: 'c'.repeat(64),
  contentType: 'application/octet-stream',
  artifactLocator: 'https://cdn.unzen.local/models/test/segment0-b.onnx_data',
};

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

  it('canonicalizes bundle components deterministically before hashing', async () => {
    const canonical = canonicalSegmentArtifactBundleFields([
      externalB,
      graphComponent,
      externalA,
    ]);

    expect(canonical.map((component) => component.path)).toEqual([
      graphComponent.path,
      externalA.path,
      externalB.path,
    ]);
    expect(canonical[0]).not.toHaveProperty('artifactLocator');

    expect(
      await computeSegmentArtifactBundleDigest([externalB, graphComponent, externalA]),
    ).toBe(await computeSegmentArtifactBundleDigest([externalA, externalB, graphComponent]));
  });

  it.each([
    ['null top-level value', null, 'components must be a non-empty array'],
    ['empty component array', [], 'components must be a non-empty array'],
    ['non-object component', [null], 'component 0 must be an object'],
    [
      'invalid role',
      [{ ...graphComponent, role: 'weights' }],
      "component 0 role must be 'graph' or 'external-data'",
    ],
    [
      'non-string path',
      [{ ...graphComponent, path: Symbol('segment') }],
      'component 0 path must be a non-empty string',
    ],
    [
      'unsafe byte size',
      [{ ...graphComponent, byteSize: Number.MAX_SAFE_INTEGER + 1 }],
      'component 0 byteSize must be a positive safe integer',
    ],
    [
      'non-canonical digest',
      [{ ...graphComponent, sha256: 'A'.repeat(64) }],
      'component 0 sha256 must be a canonical lowercase SHA-256 digest',
    ],
    [
      'blank content type',
      [{ ...graphComponent, contentType: '   ' }],
      'component 0 contentType must be a non-empty string',
    ],
    [
      'blank artifact locator',
      [{ ...graphComponent, artifactLocator: '' }],
      'component 0 artifactLocator must be a non-empty string',
    ],
  ])('fails closed on malformed bundle runtime input: %s', (_name, input, message) => {
    expect(() =>
      canonicalSegmentArtifactBundleFields(
        input as unknown as readonly SegmentArtifactComponent[],
      ),
    ).toThrow(message as string);
  });

  it('rejects duplicate component paths before canonical sorting', () => {
    expect(() =>
      canonicalSegmentArtifactBundleFields([
        graphComponent,
        { ...externalA, path: graphComponent.path },
      ]),
    ).toThrow(`duplicate component path: ${graphComponent.path}`);
  });

  it('requires exactly one graph component in a bundle', () => {
    expect(() => canonicalSegmentArtifactBundleFields([externalA])).toThrow(
      'must contain exactly one graph component; found 0',
    );
    expect(() =>
      canonicalSegmentArtifactBundleFields([
        graphComponent,
        { ...graphComponent, path: 'segment0-copy.onnx' },
      ]),
    ).toThrow('must contain exactly one graph component; found 2');
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
