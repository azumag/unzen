import { describe, expect, it } from 'vitest';
import { ENDPOINT_EMBEDDING_WEBGPU_EXPECTED } from '../browser-harness/endpoint-embedding-tiled-webgpu/contract.js';
import {
  ENDPOINT_EMBEDDING_ARTIFACT_POLICY,
  evaluateEndpointEmbeddingArtifactPolicyContract,
  verifyPinnedEndpointEmbeddingArtifactPolicyContract,
} from '../tools/verify_endpoint_embedding_artifact_policy_contract.mjs';

function candidate(): any {
  return structuredClone(ENDPOINT_EMBEDDING_WEBGPU_EXPECTED);
}

describe('endpoint embedding artifact policy contract', () => {
  it('accepts the pinned 4-artifact / 8-tile preferred-budget geometry', () => {
    const analysis = verifyPinnedEndpointEmbeddingArtifactPolicyContract();

    expect(analysis).toMatchObject({
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      kind: 'unzen-endpoint-embedding-artifact-policy-contract',
      schemaVersion: '1.0.0',
      rows: 128_256,
      hiddenSize: 2_048,
      initializerBytes: 1_050_673_152,
      totalPhysicalArtifactBytes: 1_050_673_152,
      physicalArtifactCount: 4,
      executionTileCount: 8,
      maximumPhysicalArtifactBytes: 262_668_288,
      maximumExecutionTileBytes: 131_334_144,
      maximumPhysicalArtifactPreferredHeadroomBytes: 5_767_168,
      maximumPhysicalArtifactHardHeadroomBytes: 811_073_536,
      violations: [],
    });
    expect(analysis.policy).toEqual({
      targetBytes: 209_715_200,
      preferredCeilingBytes: 268_435_456,
      normalCeilingBytes: 536_870_912,
      hardCeilingBytes: 1_073_741_824,
    });
    expect(analysis.physicalArtifacts.every((artifact) => artifact.tier === 'preferred')).toBe(true);
  });

  it('fails when a pinned physical artifact drifts above the preferred ceiling even if it remains below hard', () => {
    const value = candidate();
    const oversized = ENDPOINT_EMBEDDING_ARTIFACT_POLICY.preferredCeilingBytes + 1;
    const delta = oversized - value.physicalArtifacts[0].bytes;
    value.physicalArtifacts[0].bytes = oversized;
    value.physicalArtifacts[0].sourceEndOffsetBytesExclusive += delta;
    value.physicalArtifacts[1].sourceOffsetBytes += delta;

    const analysis = evaluateEndpointEmbeddingArtifactPolicyContract(value);
    expect(analysis.status).toBe('fail');
    expect(analysis.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'physical-artifact-preferred-ceiling' }),
    ]));
  });

  it('fails hard when any browser cache artifact exceeds the 1 GiB policy ceiling', () => {
    const value = candidate();
    const oversized = ENDPOINT_EMBEDDING_ARTIFACT_POLICY.hardCeilingBytes + 1;
    value.physicalArtifacts[0].bytes = oversized;
    value.physicalArtifacts[0].sourceEndOffsetBytesExclusive =
      value.physicalArtifacts[0].sourceOffsetBytes + oversized;

    const analysis = evaluateEndpointEmbeddingArtifactPolicyContract(value);
    expect(analysis.status).toBe('fail');
    expect(analysis.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'physical-artifact-hard-ceiling' }),
    ]));
  });

  it('fails on a gap between consecutive physical source ranges', () => {
    const value = candidate();
    value.physicalArtifacts[2].sourceOffsetBytes += 4;

    const analysis = evaluateEndpointEmbeddingArtifactPolicyContract(value);
    expect(analysis.status).toBe('fail');
    expect(analysis.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'physical-artifact-source-contiguity' }),
    ]));
  });

  it('fails when a tile no longer maps its row span to the corresponding source bytes', () => {
    const value = candidate();
    value.tiles[3].artifactByteOffset += 4;

    const analysis = evaluateEndpointEmbeddingArtifactPolicyContract(value);
    expect(analysis.status).toBe('fail');
    expect(analysis.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'execution-tile-source-mapping' }),
      expect.objectContaining({ code: 'execution-tile-artifact-contiguity' }),
    ]));
  });

  it('fails when execution tiles stop short of complete vocabulary and artifact coverage', () => {
    const value = candidate();
    value.tiles.pop();
    value.executionTileCount -= 1;

    const analysis = evaluateEndpointEmbeddingArtifactPolicyContract(value);
    expect(analysis.status).toBe('fail');
    expect(analysis.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'execution-tile-row-coverage' }),
      expect.objectContaining({ code: 'execution-tile-artifact-coverage' }),
    ]));
  });

  it('fails when a tile token boundary disagrees with its covered rows', () => {
    const value = candidate();
    value.tiles[5].globalTokenIds[1] -= 1;

    const analysis = evaluateEndpointEmbeddingArtifactPolicyContract(value);
    expect(analysis.status).toBe('fail');
    expect(analysis.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'execution-tile-global-token-boundary' }),
    ]));
  });

  it('rejects malformed unsafe byte geometry instead of coercing it', () => {
    const value = candidate();
    value.tiles[0].byteLength = -1;
    expect(() => evaluateEndpointEmbeddingArtifactPolicyContract(value)).toThrow('positive safe integer');
  });
});
