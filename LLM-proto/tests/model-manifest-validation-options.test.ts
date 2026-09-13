import { describe, expect, it } from 'vitest';
import {
  validateModelManifest,
  validateModelManifestShape,
  type ModelManifestValidationResult,
} from '../src/model-manifest-validator.js';
import { computeModelManifestDigest } from '../src/model-manifest.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';

function optionIssues(result: ModelManifestValidationResult) {
  return result.issues.filter((entry) => entry.code === 'invalid-validation-options');
}

describe('model manifest validation options runtime boundary', () => {
  it.each([
    ['null container', null],
    ['array container', []],
    ['invalid supported schema versions container', { supportedSchemaVersions: '1.0.0' }],
    ['invalid supported schema version entry', { supportedSchemaVersions: [Symbol('schema')] }],
    ['invalid allowed sources container', { allowedSources: 'production' }],
    ['invalid allowed source entry', { allowedSources: ['production', 'other'] }],
    ['invalid signature verifier', { verifySignature: 'trusted' }],
  ])('rejects %s before manifest validation', (_label, options) => {
    const result = validateModelManifestShape(
      createFixtureModelManifest(),
      options as never,
    );

    expect(result.status).toBe('invalid');
    expect(optionIssues(result)).toHaveLength(1);
    expect(result.manifest).toBeUndefined();
  });

  it('preserves explicit empty policy arrays instead of silently restoring defaults', () => {
    const unsupported = validateModelManifestShape(createFixtureModelManifest(), {
      supportedSchemaVersions: [],
    });
    expect(unsupported.status).toBe('invalid');
    expect(unsupported.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unsupported-schema-version' })]),
    );

    const disallowed = validateModelManifestShape(createFixtureModelManifest(), {
      allowedSources: [],
    });
    expect(disallowed.status).toBe('invalid');
    expect(disallowed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'fixture-manifest-not-allowed' })]),
    );
  });

  it('uses the signature verifier captured at async validation entry', async () => {
    const fixture = createFixtureModelManifest();
    const signed = {
      ...fixture,
      signature: 'fixture-signature',
      manifestDigest: '0'.repeat(64),
    };
    signed.manifestDigest = await computeModelManifestDigest(signed);

    let initialCalls = 0;
    let replacementCalls = 0;
    const options = {
      verifySignature: async () => {
        initialCalls++;
        return true;
      },
    };

    const validation = validateModelManifest(signed, options);
    options.verifySignature = async () => {
      replacementCalls++;
      return false;
    };

    const result = await validation;
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
    expect(initialCalls).toBe(1);
    expect(replacementCalls).toBe(0);
  });
});
