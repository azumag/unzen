import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED } from '../browser-harness/endpoint-embedding-eight-physical-webgpu/contract.js';
import {
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT,
  evaluateEndpointEmbeddingEightPhysicalBundle,
  inspectRegularFile,
  parseEndpointEmbeddingEightPhysicalPreflightArgs,
} from '../tools/preflight_endpoint_embedding_eight_physical_bundle.mjs';

function validManifest() {
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
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
    physicalArtifacts: Array.from({ length: 8 }, (_, index) => ({
      index,
      file: `payload-${String(index).padStart(4, '0')}.bin`,
      bytes: expected.tileBytes,
      sha256: (index + 1).toString(16).repeat(64),
      sourceOffsetBytes: index * expected.tileBytes,
      sourceEndOffsetBytesExclusive: (index + 1) * expected.tileBytes,
    })),
    payloadSetSha256: 'f'.repeat(64),
    tiles: Array.from({ length: 8 }, (_, index) => ({
      tileIndex: index,
      startRow: index * expected.rowsPerTile,
      endRowExclusive: (index + 1) * expected.rowsPerTile,
      rowCount: expected.rowsPerTile,
      physicalArtifactIndex: index,
      artifactByteOffset: 0,
      byteLength: expected.tileBytes,
    })),
    coverage: {
      sourceOffsetBytes: 0,
      sourceEndOffsetBytesExclusive: expected.totalEmbeddingBytes,
      bytes: expected.totalEmbeddingBytes,
      contiguous: true,
      tileToPhysicalArtifactOneToOne: true,
    },
    remainingRuntimeEvidence: ['ort-webgpu-range-supply'],
  };
}

function validInspections(manifest: ReturnType<typeof validManifest>) {
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  return {
    graph: {
      file: expected.graphFile,
      bytes: expected.graphBytes,
      sha256: expected.graphSha256,
    },
    payloads: manifest.physicalArtifacts.map((artifact) => ({
      file: artifact.file,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
  };
}

describe('8-physical endpoint embedding bundle preflight', () => {
  it('binds actual-file inspection evidence to the runtime plan', () => {
    const manifest = validManifest();
    const report = evaluateEndpointEmbeddingEightPhysicalBundle(manifest, validInspections(manifest));
    expect(report.kind).toBe(ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT.kind);
    expect(report.status).toBe('pass');
    expect(report.decisionStatus).toBe('diagnostic-only');
    expect(report.selectedPhysicalArtifactCount).toBeNull();
    expect(report.payloads).toHaveLength(8);
    expect(report.runtimePlan).toHaveLength(8);
    expect(report.graph.sha256).toBe(ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED.graphSha256);
    expect(report.evidenceBoundary).toBe('actual-file-integrity-preflight-only');
  });

  it.each([
    ['graph bytes', (inspections: any) => { inspections.graph.bytes += 1; }],
    ['graph sha', (inspections: any) => { inspections.graph.sha256 = '0'.repeat(64); }],
    ['payload count', (inspections: any) => { inspections.payloads.pop(); }],
    ['payload file', (inspections: any) => { inspections.payloads[2].file = 'payload-9999.bin'; }],
    ['payload bytes', (inspections: any) => { inspections.payloads[3].bytes -= 1; }],
    ['payload sha', (inspections: any) => { inspections.payloads[4].sha256 = '0'.repeat(64); }],
  ])('fails closed on %s mismatch', (_name, mutate) => {
    const manifest = validManifest();
    const inspections = validInspections(manifest);
    mutate(inspections);
    expect(() => evaluateEndpointEmbeddingEightPhysicalBundle(manifest, inspections)).toThrow();
  });

  it('hashes files without loading the whole file as one buffer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unzen-eight-physical-preflight-'));
    try {
      const path = join(dir, 'payload.bin');
      const bytes = Buffer.from('range-supply-preflight');
      await writeFile(path, bytes);
      const result = await inspectRegularFile(path);
      expect(result).toEqual({
        file: 'payload.bin',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      expect(ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT.hashBufferBytes).toBe(1024 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects symbolic links before hashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unzen-eight-physical-preflight-link-'));
    try {
      const target = join(dir, 'target.bin');
      const link = join(dir, 'payload.bin');
      await writeFile(target, 'target');
      await symlink(target, link);
      await expect(inspectRegularFile(link)).rejects.toThrow(/symbolic link/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('requires exactly manifest, graph, and payload-directory CLI arguments', () => {
    expect(
      parseEndpointEmbeddingEightPhysicalPreflightArgs(['manifest.json', 'embedding-offset-0.onnx', 'payloads']),
    ).toEqual({
      manifestPath: 'manifest.json',
      graphPath: 'embedding-offset-0.onnx',
      payloadDir: 'payloads',
    });
    expect(() => parseEndpointEmbeddingEightPhysicalPreflightArgs(['manifest.json'])).toThrow(/usage/);
  });
});
