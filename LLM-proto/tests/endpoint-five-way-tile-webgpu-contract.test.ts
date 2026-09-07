import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_FIVE_WAY_WEBGPU_EXPECTED,
  validateEndpointFiveWayWebGpuManifest,
} from '../browser-harness/endpoint-five-way-tile-webgpu/contract.js';

function validManifest() {
  const expected = ENDPOINT_FIVE_WAY_WEBGPU_EXPECTED;
  return structuredClone({
    schemaVersion: expected.schemaVersion,
    kind: expected.manifestKind,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    sourceGraphSha256: expected.sourceGraphSha256,
    sourceExternalData: { bytes: expected.sourceExternalBytes, sha256: expected.sourceExternalSha256 },
    physicalArtifactCount: expected.physicalArtifactCount,
    executionTileCount: expected.executionTileCount,
    selectedTileIndex: expected.selectedTileIndex,
    hiddenSize: expected.hiddenSize,
    onnxruntimeWebVersion: expected.onnxruntimeWebVersion,
    physicalArtifacts: expected.physicalArtifacts,
    tile: expected.tile,
  });
}

describe('endpoint five-way WebGPU diagnostic manifest contract', () => {
  it('accepts only the pinned two-payload preparation manifest', () => {
    const manifest = validManifest();
    expect(validateEndpointFiveWayWebGpuManifest(manifest)).toBe(manifest);
  });

  it.each([
    ['source graph', (manifest: any) => { manifest.sourceGraphSha256 = '0'.repeat(64); }],
    ['source external data', (manifest: any) => { manifest.sourceExternalData.sha256 = 'f'.repeat(64); }],
    ['first physical payload', (manifest: any) => { manifest.physicalArtifacts[0].sha256 = 'a'.repeat(64); }],
    ['second physical payload', (manifest: any) => { manifest.physicalArtifacts[1].sha256 = 'b'.repeat(64); }],
    ['crossing slice offset', (manifest: any) => { manifest.tile.physicalSlices[0].artifactByteOffset += 8192; }],
    ['second slice artifact', (manifest: any) => { manifest.tile.physicalSlices[1].physicalArtifactIndex = 0; }],
    ['graph digest', (manifest: any) => { manifest.tile.graphs.logits.sha256 = 'c'.repeat(64); }],
    ['decision promotion', (manifest: any) => { manifest.decisionStatus = 'approved'; }],
  ])('rejects %s drift before ORT execution', (_label, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => validateEndpointFiveWayWebGpuManifest(manifest)).toThrow(/contract mismatch/);
  });
});
