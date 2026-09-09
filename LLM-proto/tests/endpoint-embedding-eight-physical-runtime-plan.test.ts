import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED,
  buildEndpointEmbeddingEightPhysicalRuntimePlan,
  validateEndpointEmbeddingEightPhysicalManifest,
} from '../browser-harness/endpoint-embedding-eight-physical-webgpu/contract.js';

function validManifest() {
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  const physicalArtifacts = Array.from({ length: 8 }, (_, index) => ({
    index,
    file: `payload-${String(index).padStart(4, '0')}.bin`,
    bytes: expected.tileBytes,
    sha256: (index + 1).toString(16).repeat(64),
    sourceOffsetBytes: index * expected.tileBytes,
    sourceEndOffsetBytesExclusive: (index + 1) * expected.tileBytes,
  }));
  const tiles = Array.from({ length: 8 }, (_, index) => ({
    tileIndex: index,
    startRow: index * expected.rowsPerTile,
    endRowExclusive: (index + 1) * expected.rowsPerTile,
    rowCount: expected.rowsPerTile,
    physicalArtifactIndex: index,
    artifactByteOffset: 0,
    byteLength: expected.tileBytes,
  }));
  return {
    schemaVersion: expected.schemaVersion,
    kind: expected.manifestKind,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    candidatePhysicalArtifactCount: 8,
    executionTileCount: 8,
    sourceGraphSha256: expected.sourceGraphSha256,
    sourceExternalData: { ...expected.sourceExternalData },
    embeddingInitializer: { ...expected.embeddingInitializer },
    physicalArtifacts,
    payloadSetSha256: 'f'.repeat(64),
    tiles,
    coverage: {
      sourceOffsetBytes: 0,
      sourceEndOffsetBytesExclusive: expected.totalEmbeddingBytes,
      bytes: expected.totalEmbeddingBytes,
      contiguous: true,
      tileToPhysicalArtifactOneToOne: true,
    },
    remainingRuntimeEvidence: [
      'ort-webgpu-range-supply',
      'host-peak-working-set',
      'gpu-peak-working-set',
    ],
  };
}

describe('8-physical endpoint embedding runtime-plan contract', () => {
  it('accepts a generated diagnostic manifest and builds a deterministic 1:1 runtime plan', () => {
    const manifest = validManifest();
    expect(validateEndpointEmbeddingEightPhysicalManifest(manifest)).toBe(manifest);

    const plan = buildEndpointEmbeddingEightPhysicalRuntimePlan(manifest);
    expect(plan).toHaveLength(8);
    expect(plan.map((entry) => entry.physicalArtifactIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(plan.map((entry) => entry.payloadFile)).toEqual(
      Array.from({ length: 8 }, (_, index) => `payload-${String(index).padStart(4, '0')}.bin`),
    );
    expect(plan.every((entry) => entry.graphFile === 'embedding-offset-0.onnx')).toBe(true);
    expect(plan.every((entry) => entry.graphExternalDataPath === 'payload-0000.bin')).toBe(true);
    expect(plan.every((entry) => entry.artifactByteOffset === 0)).toBe(true);
    expect(plan.every((entry) => entry.byteLength === 131_334_144)).toBe(true);
  });

  it.each([
    ['decision status', (manifest: any) => { manifest.decisionStatus = 'approved'; }],
    ['selected layout', (manifest: any) => { manifest.selectedPhysicalArtifactCount = 8; }],
    ['source graph identity', (manifest: any) => { manifest.sourceGraphSha256 = '0'.repeat(64); }],
    ['source external-data identity', (manifest: any) => { manifest.sourceExternalData.sha256 = '0'.repeat(64); }],
    ['payload file traversal', (manifest: any) => { manifest.physicalArtifacts[3].file = '../payload.bin'; }],
    ['payload byte length', (manifest: any) => { manifest.physicalArtifacts[2].bytes -= 1; }],
    ['payload sha casing', (manifest: any) => { manifest.physicalArtifacts[4].sha256 = 'A'.repeat(64); }],
    ['payload source gap', (manifest: any) => { manifest.physicalArtifacts[5].sourceOffsetBytes += 1; }],
    ['tile routing', (manifest: any) => { manifest.tiles[6].physicalArtifactIndex = 5; }],
    ['tile artifact offset', (manifest: any) => { manifest.tiles[1].artifactByteOffset = 1; }],
    ['tile row range', (manifest: any) => { manifest.tiles[7].startRow -= 1; }],
    ['coverage', (manifest: any) => { manifest.coverage.contiguous = false; }],
    ['range-supply blocker removal', (manifest: any) => { manifest.remainingRuntimeEvidence = ['host-peak-working-set']; }],
  ])('fails closed on %s drift', (_name, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => validateEndpointEmbeddingEightPhysicalManifest(manifest)).toThrow();
  });

  it('rejects malformed aggregate and payload SHA-256 identities', () => {
    const aggregate = validManifest();
    aggregate.payloadSetSha256 = 'not-a-sha';
    expect(() => validateEndpointEmbeddingEightPhysicalManifest(aggregate)).toThrow(/payloadSetSha256/);

    const payload = validManifest();
    payload.physicalArtifacts[0].sha256 = 'g'.repeat(64);
    expect(() => validateEndpointEmbeddingEightPhysicalManifest(payload)).toThrow(/canonical lowercase SHA-256/);
  });
});
