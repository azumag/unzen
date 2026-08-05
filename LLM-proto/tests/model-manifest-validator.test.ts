import { describe, expect, it } from 'vitest';
import {
  validateModelManifest,
  validateModelManifestShape,
  type ModelManifestValidationResult,
} from '../src/model-manifest-validator.js';
import { computeModelManifestDigest } from '../src/model-manifest.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';

function codes(result: ModelManifestValidationResult): readonly string[] {
  return result.issues.map((issue) => issue.code);
}

describe('validateModelManifestShape (sync fail-fast structural checks)', () => {
  it('accepts a well-formed fixture manifest', () => {
    const result = validateModelManifestShape(createFixtureModelManifest());
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
  });

  it('rejects a non-object manifest', () => {
    const result = validateModelManifestShape('not-a-manifest');
    expect(result.status).toBe('invalid');
    expect(codes(result)).toContain('invalid-manifest');
  });

  it('rejects an unsupported schema version', () => {
    const result = validateModelManifestShape({
      ...createFixtureModelManifest(),
      schemaVersion: '9.9.9',
    });
    expect(codes(result)).toContain('unsupported-schema-version');
  });

  it('rejects a missing schema version', () => {
    const { schemaVersion: _omitted, ...withoutSchemaVersion } = createFixtureModelManifest();
    const result = validateModelManifestShape(withoutSchemaVersion);
    expect(codes(result)).toContain('invalid-manifest');
  });

  it('rejects fixture manifests when the production source is required', () => {
    const result = validateModelManifestShape(createFixtureModelManifest(), {
      allowedSources: ['production'],
    });
    expect(result.status).toBe('invalid');
    expect(codes(result)).toContain('fixture-manifest-not-allowed');
  });

  it('accepts a production manifest when the production source is required', () => {
    const result = validateModelManifestShape(
      { ...createFixtureModelManifest(), source: 'production' },
      { allowedSources: ['production'] },
    );
    expect(result.status).toBe('valid');
  });

  it('rejects a layer-range gap between segments', () => {
    const manifest = createFixtureModelManifest();
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.map((segment, index) =>
        index === 3 ? { ...segment, layerStart: segment.layerStart + 1 } : segment,
      ),
    });
    expect(codes(result)).toContain('non-contiguous-layer-ranges');
  });

  it('rejects overlapping layer ranges', () => {
    const manifest = createFixtureModelManifest();
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.map((segment, index) =>
        index === 3 ? { ...segment, layerStart: segment.layerStart - 1 } : segment,
      ),
    });
    expect(codes(result)).toContain('non-contiguous-layer-ranges');
  });

  it('rejects duplicate segment indexes', () => {
    const manifest = createFixtureModelManifest();
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.map((segment, index) =>
        index === 4 ? { ...segment, index: 0 } : segment,
      ),
    });
    expect(codes(result)).toContain('duplicate-segment-index');
  });

  it('rejects a non-zero-based segment index set (missing index)', () => {
    const manifest = createFixtureModelManifest();
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.map((segment, index) =>
        index === 4 ? { ...segment, index: 10 } : segment,
      ),
    });
    expect(codes(result)).toContain('missing-segment-index');
  });

  it('rejects placeholder artifact hashes such as sha256:segment-0', () => {
    const manifest = createFixtureModelManifest();
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.map((segment, index) =>
        index === 2 ? { ...segment, sha256: `sha256:segment-${index}` } : segment,
      ),
    });
    expect(codes(result)).toContain('placeholder-artifact-digest');
  });

  it('rejects non-hex artifact hashes', () => {
    const manifest = createFixtureModelManifest();
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.map((segment, index) =>
        index === 2 ? { ...segment, sha256: 'not-a-real-sha256' } : segment,
      ),
    });
    expect(codes(result)).toContain('invalid-artifact-digest');
  });

  it('rejects a zero or negative artifact byte size', () => {
    const manifest = createFixtureModelManifest();
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.map((segment, index) =>
        index === 2 ? { ...segment, byteSize: 0 } : segment,
      ),
    });
    expect(codes(result)).toContain('invalid-artifact-byte-size');
  });

  it('rejects segments that do not cover the declared totalLayers', () => {
    const manifest = createFixtureModelManifest();
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.slice(0, manifest.segments.length - 1),
    });
    expect(codes(result)).toContain('segments-incomplete');
  });

  it('rejects a layer range that exceeds totalLayers', () => {
    const manifest = createFixtureModelManifest();
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.map((segment, index) =>
        index === 7 ? { ...segment, layerEnd: manifest.totalLayers } : segment,
      ),
    });
    expect(codes(result)).toContain('layers-outside-model');
  });

  it('rejects an empty segments array', () => {
    const result = validateModelManifestShape({
      ...createFixtureModelManifest(),
      segments: [],
    });
    expect(codes(result)).toContain('empty-segments');
  });

  it('rejects an unsupported quantization format', () => {
    const result = validateModelManifestShape({
      ...createFixtureModelManifest(),
      quantization: '4bit',
    });
    expect(codes(result)).toContain('invalid-quantization');
  });

  it('rejects quantization not listed in the runtime requirements', () => {
    const result = validateModelManifestShape({
      ...createFixtureModelManifest(),
      quantization: 'fp16',
    });
    expect(codes(result)).toContain('unsupported-quantization');
  });

  it('rejects an invalid manifest digest format', () => {
    const result = validateModelManifestShape({
      ...createFixtureModelManifest(),
      manifestDigest: 'sha256:segment-0',
    });
    expect(codes(result)).toContain('invalid-manifest-digest');
  });
});

describe('validateModelManifest (async digest and signature verification)', () => {
  async function productionManifest() {
    const fixture = createFixtureModelManifest();
    // The digest binds the source marker, so recompute after switching to
    // 'production' (the production source is not a fixture-namespace manifest).
    const manifest = { ...fixture, source: 'production' as const };
    const manifestDigest = await computeModelManifestDigest(manifest);
    return { ...manifest, manifestDigest };
  }

  it('accepts a manifest whose digest matches the recomputed canonical digest', async () => {
    const result = await validateModelManifest(await productionManifest());
    expect(result.status).toBe('valid');
  });

  it('rejects a tampered manifest digest', async () => {
    const manifest = { ...(await productionManifest()), manifestDigest: 'a'.repeat(64) };
    const result = await validateModelManifest(manifest);
    expect(result.status).toBe('invalid');
    expect(codes(result)).toContain('manifest-digest-mismatch');
  });

  it('requires a verifier callback when a signature is present', async () => {
    const manifest = { ...(await productionManifest()), signature: 'signature-v1' };
    const result = await validateModelManifest(manifest);
    expect(codes(result)).toContain('signature-verifier-unavailable');
  });

  it('rejects a signature that does not verify against the digest', async () => {
    const manifest = { ...(await productionManifest()), signature: 'signature-v1' };
    const result = await validateModelManifest(manifest, {
      verifySignature: async () => false,
    });
    expect(result.status).toBe('invalid');
    expect(codes(result)).toContain('signature-mismatch');
  });

  it('accepts a signature that verifies against the manifest digest', async () => {
    const manifest = { ...(await productionManifest()), signature: 'signature-v1' };
    const result = await validateModelManifest(manifest, {
      verifySignature: async ({ digest, signature }) =>
        digest === manifest.manifestDigest && signature === 'signature-v1',
    });
    expect(result.status).toBe('valid');
  });
});
