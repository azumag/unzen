import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_POSTSTAGE_WEBGPU_EXPECTED,
  validateEndpointPoststageWebGpuManifest,
} from '../browser-harness/endpoint-poststage-tiled-webgpu/contract.js';

function validManifest() {
  const expected = ENDPOINT_POSTSTAGE_WEBGPU_EXPECTED;
  return structuredClone({
    schemaVersion: expected.schemaVersion,
    kind: expected.manifestKind,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    sourceGraphSha256: expected.sourceGraphSha256,
    verifiedPinnedSourceGraph: expected.verifiedPinnedSourceGraph,
    sourceExternalData: expected.sourceExternalData,
    physicalArtifactCount: expected.physicalArtifactCount,
    executionTileCount: expected.executionTileCount,
    rows: expected.rows,
    hiddenSize: expected.hiddenSize,
    onnxruntimeWebVersion: expected.onnxruntimeWebVersion,
    referenceOnnxruntime: expected.referenceOnnxruntime,
    finalNorm: expected.finalNorm,
    physicalArtifacts: expected.physicalArtifacts,
    tiles: expected.tiles,
    inputs: expected.inputs,
    referenceOutputs: expected.referenceOutputs,
    sequentialExecution: expected.sequentialExecution,
  });
}

describe('endpoint complete post-stage WebGPU diagnostic manifest contract', () => {
  it('accepts only the pinned preparation contract', () => {
    const manifest = validManifest();
    expect(validateEndpointPoststageWebGpuManifest(manifest)).toBe(manifest);
  });

  it.each([
    ['source graph', (manifest: any) => { manifest.sourceGraphSha256 = '0'.repeat(64); }],
    ['verified source graph', (manifest: any) => { manifest.verifiedPinnedSourceGraph.sha256 = '1'.repeat(64); }],
    ['source external data', (manifest: any) => { manifest.sourceExternalData.sha256 = 'f'.repeat(64); }],
    ['final norm operator', (manifest: any) => { manifest.finalNorm.opType = 'LayerNormalization'; }],
    ['final norm weight range', (manifest: any) => { manifest.finalNorm.weight.sourceOffsetBytes += 8192; }],
    ['final norm graph digest', (manifest: any) => { manifest.finalNorm.graph.sha256 = 'a'.repeat(64); }],
    ['physical payload digest', (manifest: any) => { manifest.physicalArtifacts[2].sha256 = 'b'.repeat(64); }],
    ['tile range', (manifest: any) => { manifest.tiles[5].artifactByteOffset += 8192; }],
    ['tile graph digest', (manifest: any) => { manifest.tiles[7].graph.sha256 = 'c'.repeat(64); }],
    ['input digest', (manifest: any) => { manifest.inputs[manifest.finalNorm.inputNames[0]].sha256 = 'd'.repeat(64); }],
    ['reference logits digest', (manifest: any) => { manifest.referenceOutputs.logits.sha256 = 'e'.repeat(64); }],
    ['execution order', (manifest: any) => { manifest.sequentialExecution.physicalArtifactOrder = [0, 2, 1, 3]; }],
    ['decision promotion', (manifest: any) => { manifest.decisionStatus = 'approved'; }],
  ])('rejects %s drift before ORT execution', (_label, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => validateEndpointPoststageWebGpuManifest(manifest)).toThrow(/contract mismatch/);
  });
});
