import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_TILE_WEBGPU_EXPECTED,
  validateEndpointTileWebGpuManifest,
} from '../browser-harness/endpoint-tile-webgpu/contract.js';

function validManifest() {
  const expected = ENDPOINT_TILE_WEBGPU_EXPECTED;
  return structuredClone({
    schemaVersion: expected.schemaVersion,
    kind: expected.manifestKind,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    sourceGraphSha256: expected.sourceGraphSha256,
    sourceExternalData: { bytes: expected.sourceExternalBytes, sha256: expected.sourceExternalSha256 },
    physicalArtifact: { index: 0, file: expected.payloadFile, bytes: expected.payloadBytes, sha256: expected.payloadSha256 },
    physicalArtifactCount: expected.physicalArtifactCount,
    executionTileCount: expected.executionTileCount,
    selectedTileIndices: expected.selectedTileIndices,
    hiddenSize: expected.hiddenSize,
    onnxruntimeWebVersion: expected.onnxruntimeWebVersion,
    tiles: expected.tiles,
  });
}

describe('endpoint tile WebGPU diagnostic manifest contract', () => {
  it('accepts only the pinned preparation manifest', () => {
    const manifest = validManifest();
    expect(validateEndpointTileWebGpuManifest(manifest)).toBe(manifest);
  });

  it.each([
    ['source graph', (manifest: any) => { manifest.sourceGraphSha256 = '0'.repeat(64); }],
    ['source external data', (manifest: any) => { manifest.sourceExternalData.sha256 = 'f'.repeat(64); }],
    ['physical payload', (manifest: any) => { manifest.physicalArtifact.sha256 = 'a'.repeat(64); }],
    ['non-zero tile offset', (manifest: any) => { manifest.tiles[1].artifactByteOffset += 8192; }],
    ['graph digest', (manifest: any) => { manifest.tiles[1].graphs.logits.sha256 = 'b'.repeat(64); }],
    ['decision promotion', (manifest: any) => { manifest.decisionStatus = 'approved'; }],
  ])('rejects %s drift before ORT execution', (_label, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => validateEndpointTileWebGpuManifest(manifest)).toThrow(/contract mismatch/);
  });
});
