import { describe, expect, it } from 'vitest';
import {
  validateModelManifest,
  validateModelManifestShape,
} from '../src/model-manifest-validator.js';
import { computeModelManifestDigest } from '../src/model-manifest.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';

describe('validated model manifest ownership', () => {
  it('returns an owned frozen snapshot isolated from caller mutation', () => {
    const fixture = createFixtureModelManifest();
    const first = fixture.segments[0];
    const input = {
      ...fixture,
      runtimeRequirements: {
        ...fixture.runtimeRequirements,
        supportedQuantization: [...fixture.runtimeRequirements.supportedQuantization],
      },
      segments: [
        {
          ...first,
          compatibleRuntimes: [...first.compatibleRuntimes],
          components: [
            {
              role: 'graph' as const,
              path: 'segment-0.onnx',
              byteSize: first.byteSize,
              sha256: 'a'.repeat(64),
              contentType: 'application/onnx',
              artifactLocator: first.artifactLocator,
            },
          ],
        },
        ...fixture.segments.slice(1).map((segment) => ({
          ...segment,
          compatibleRuntimes: [...segment.compatibleRuntimes],
        })),
      ],
    };

    const result = validateModelManifestShape(input);
    expect(result.status).toBe('valid');
    expect(result.manifest).toBeDefined();

    const validated = result.manifest!;
    expect(validated).not.toBe(input);
    expect(validated.segments).not.toBe(input.segments);
    expect(validated.segments[0]).not.toBe(input.segments[0]);
    expect(validated.segments[0].compatibleRuntimes).not.toBe(
      input.segments[0].compatibleRuntimes,
    );
    expect(validated.segments[0].components).not.toBe(input.segments[0].components);
    expect(validated.runtimeRequirements).not.toBe(input.runtimeRequirements);
    expect(validated.runtimeRequirements.supportedQuantization).not.toBe(
      input.runtimeRequirements.supportedQuantization,
    );

    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.segments)).toBe(true);
    expect(Object.isFrozen(validated.segments[0])).toBe(true);
    expect(Object.isFrozen(validated.segments[0].compatibleRuntimes)).toBe(true);
    expect(Object.isFrozen(validated.segments[0].components)).toBe(true);
    expect(Object.isFrozen(validated.segments[0].components![0])).toBe(true);
    expect(Object.isFrozen(validated.runtimeRequirements)).toBe(true);
    expect(Object.isFrozen(validated.runtimeRequirements.supportedQuantization)).toBe(true);

    const originalRevision = validated.modelRevision;
    const originalLayerStart = validated.segments[0].layerStart;
    const originalRuntime = validated.segments[0].compatibleRuntimes[0];
    const originalComponentPath = validated.segments[0].components![0].path;
    const originalMinimumRuntime = validated.runtimeRequirements.minimumRuntimeVersion;
    const originalQuantization = validated.runtimeRequirements.supportedQuantization[0];

    const mutable = input as typeof input & Record<string, unknown>;
    mutable.modelRevision = 'tampered-revision';
    input.segments[0].layerStart = 99;
    input.segments[0].compatibleRuntimes[0] = 'tampered-runtime';
    input.segments[0].components![0].path = 'tampered.onnx';
    input.runtimeRequirements.minimumRuntimeVersion = '999.0.0';
    input.runtimeRequirements.supportedQuantization[0] = 'q8';

    expect(validated.modelRevision).toBe(originalRevision);
    expect(validated.segments[0].layerStart).toBe(originalLayerStart);
    expect(validated.segments[0].compatibleRuntimes[0]).toBe(originalRuntime);
    expect(validated.segments[0].components![0].path).toBe(originalComponentPath);
    expect(validated.runtimeRequirements.minimumRuntimeVersion).toBe(originalMinimumRuntime);
    expect(validated.runtimeRequirements.supportedQuantization[0]).toBe(originalQuantization);
  });

  it('keeps async digest verification stable when the caller mutates after validation starts', async () => {
    const fixture = createFixtureModelManifest();
    const input = {
      ...fixture,
      runtimeRequirements: {
        ...fixture.runtimeRequirements,
        supportedQuantization: [...fixture.runtimeRequirements.supportedQuantization],
      },
      segments: fixture.segments.map((segment) => ({
        ...segment,
        compatibleRuntimes: [...segment.compatibleRuntimes],
      })),
      manifestDigest: '0'.repeat(64),
    };
    input.manifestDigest = await computeModelManifestDigest(input);

    const originalRevision = input.modelRevision;
    const originalLayerStart = input.segments[0].layerStart;
    const validation = validateModelManifest(input);

    input.modelRevision = 'raced-revision';
    input.segments[0].layerStart = 999;
    input.runtimeRequirements.supportedQuantization[0] = 'q8';

    const result = await validation;
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
    expect(result.manifest?.modelRevision).toBe(originalRevision);
    expect(result.manifest?.segments[0].layerStart).toBe(originalLayerStart);
    expect(result.manifest?.runtimeRequirements.supportedQuantization).toEqual(['q4']);
  });
});
