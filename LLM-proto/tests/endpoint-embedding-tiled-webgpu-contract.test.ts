import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_EMBEDDING_WEBGPU_EXPECTED,
  validateEndpointEmbeddingWebGpuManifest,
} from '../browser-harness/endpoint-embedding-tiled-webgpu/contract.js';

function validManifest() {
  const expected = ENDPOINT_EMBEDDING_WEBGPU_EXPECTED;
  const manifest = JSON.parse(JSON.stringify(expected));
  manifest.kind = expected.manifestKind;
  manifest.status = 'pass';
  manifest.decisionStatus = 'diagnostic-only';
  delete manifest.manifestKind;
  return manifest;
}

describe('complete endpoint embedding WebGPU manifest contract', () => {
  it('accepts the pinned 4-payload / 8-tile diagnostic manifest', () => {
    const manifest = validManifest();
    expect(validateEndpointEmbeddingWebGpuManifest(manifest)).toBe(manifest);
    expect(manifest.tokenIds).toHaveLength(16);
    expect(manifest.tiles).toHaveLength(8);
    expect(manifest.tiles.map((tile: { physicalArtifactIndex: number }) => tile.physicalArtifactIndex))
      .toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it.each([
    ['decision status', (manifest: any) => { manifest.decisionStatus = 'approved'; }],
    ['source graph', (manifest: any) => { manifest.sourceGraphSha256 = '0'.repeat(64); }],
    ['source external data', (manifest: any) => { manifest.sourceExternalData.sha256 = '0'.repeat(64); }],
    ['payload identity', (manifest: any) => { manifest.physicalArtifacts[2].sha256 = '0'.repeat(64); }],
    ['graph identity', (manifest: any) => { manifest.graphVariants.offsetHalf.sha256 = '0'.repeat(64); }],
    ['tile routing', (manifest: any) => { manifest.tiles[5].physicalArtifactIndex = 3; }],
    ['token routing', (manifest: any) => { manifest.tokenIds[8] += 1; }],
  ])('fails closed on %s drift', (_name, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => validateEndpointEmbeddingWebGpuManifest(manifest)).toThrow(/contract mismatch/);
  });
});

it('keeps the browser runner WebGPU-only, payload-referenced, and release-aware', () => {
  const runner = readFileSync(
    new URL('../browser-harness/endpoint-embedding-tiled-webgpu/runner.js', import.meta.url),
    'utf8',
  );
  expect(runner).toContain("executionProviders: ['webgpu']");
  expect(runner).toContain('referenceEmbedding(');
  expect(runner).toContain('await session.release();');
  expect(runner).toContain('completeEmbeddingComparison');
  expect(runner).toContain('window.__unzenEndpointEmbeddingWebGpuReport = report;');
});
