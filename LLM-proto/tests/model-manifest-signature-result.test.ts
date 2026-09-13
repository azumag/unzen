import { describe, expect, it } from 'vitest';
import { validateModelManifest } from '../src/model-manifest-validator.js';
import { computeModelManifestDigest } from '../src/model-manifest.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';

async function createSignedFixture() {
  const fixture = createFixtureModelManifest();
  const manifest = {
    ...fixture,
    signature: 'fixture-signature',
    manifestDigest: '0'.repeat(64),
  };
  manifest.manifestDigest = await computeModelManifestDigest(manifest);
  return manifest;
}

describe('model manifest signature verifier result contract', () => {
  it.each([
    ['object', { verified: true }],
    ['string', 'verified'],
    ['number', 1],
    ['symbol', Symbol('verified')],
  ])('fails closed on truthy non-boolean %s results', async (_label, verifierResult) => {
    const manifest = await createSignedFixture();
    const result = await validateModelManifest(manifest, {
      verifySignature: (async () => verifierResult) as never,
    });

    expect(result.status).toBe('invalid');
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'signature-mismatch' })]),
    );
  });

  it('continues to accept exact true and reject exact false', async () => {
    const accepted = await validateModelManifest(await createSignedFixture(), {
      verifySignature: async () => true,
    });
    expect(accepted.status).toBe('valid');

    const rejected = await validateModelManifest(await createSignedFixture(), {
      verifySignature: async () => false,
    });
    expect(rejected.status).toBe('invalid');
    expect(rejected.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'signature-mismatch' })]),
    );
  });
});
