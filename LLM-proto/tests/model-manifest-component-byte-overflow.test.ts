import { describe, expect, it } from 'vitest';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { validateModelManifestShape } from '../src/model-manifest-validator.js';

function component(role: 'graph' | 'external-data', path: string, byteSize: number, locator: string) {
  return {
    role,
    path,
    byteSize,
    sha256: role === 'graph' ? 'a'.repeat(64) : 'b'.repeat(64),
    contentType: 'application/octet-stream',
    artifactLocator: locator,
  } as const;
}

describe('model manifest component byte accumulation', () => {
  it('fails closed before individually safe component sizes overflow the exact total', () => {
    const manifest = createFixtureModelManifest();
    const first = manifest.segments[0];
    const graphLocator = first.artifactLocator;
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.map((segment, index) =>
        index === 0
          ? {
              ...segment,
              byteSize: Number.MAX_SAFE_INTEGER,
              components: [
                component('graph', 'segment-0.onnx', Number.MAX_SAFE_INTEGER, graphLocator),
                component('external-data', 'segment-0.onnx.data', 1, `${graphLocator}.data`),
              ],
            }
          : segment,
      ),
    });

    expect(result.status).toBe('invalid');
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'artifact-component-byte-size-mismatch',
          path: '$.segments[0].components',
          message: 'component bytes exceed Number.MAX_SAFE_INTEGER; exact byte total is required',
        }),
      ]),
    );
  });

  it('preserves exact component totals within the safe-integer range', () => {
    const manifest = createFixtureModelManifest();
    const first = manifest.segments[0];
    const graphLocator = first.artifactLocator;
    const result = validateModelManifestShape({
      ...manifest,
      segments: manifest.segments.map((segment, index) =>
        index === 0
          ? {
              ...segment,
              byteSize: 15,
              components: [
                component('graph', 'segment-0.onnx', 10, graphLocator),
                component('external-data', 'segment-0.onnx.data', 5, `${graphLocator}.data`),
              ],
            }
          : segment,
      ),
    });

    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
  });
});
