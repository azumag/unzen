import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED } from '../browser-harness/endpoint-embedding-eight-physical-webgpu/contract.js';
import {
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_PREFLIGHT,
  assertNonSymlinkDirectory,
  calculateEndpointEmbeddingPayloadSetSha256,
  evaluateEndpointEmbeddingEightPhysicalBundle,
  inspectRegularFile,
  parseEndpointEmbeddingEightPhysicalPreflightArgs,
  readRegularJsonFile,
} from '../tools/preflight_endpoint_embedding_eight_physical_bundle.mjs';

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
    payloadSetSha256: calculateEndpointEmbeddingPayloadSetSha256(physicalArtifacts),
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
    expect(report.manifestPayloadSetSha256).toBe(
      calculateEndpointEmbeddingPayloadSetSha256(manifest.physicalArtifacts),
    );
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

  it('fails closed when the generated payload-set digest does not match artifact metadata', () => {
    const manifest = validManifest();
    manifest.payloadSetSha256 = '0'.repeat(64);
    expect(() => evaluateEndpointEmbeddingEightPhysicalBundle(manifest, validInspections(manifest)))
      .toThrow(/manifest\.payloadSetSha256 mismatch/);
  });

  it('matches the Python generator canonical payload-set serialization contract', () => {
    const artifacts = [{
      index: 0,
      file: 'payload-0000.bin',
      bytes: 3,
      sha256: 'a'.repeat(64),
      sourceOffsetBytes: 0,
      sourceEndOffsetBytesExclusive: 3,
    }];
    const pythonCanonical = '[{"bytes":3,"file":"payload-0000.bin","index":0,"sha256":"'
      + `${'a'.repeat(64)}","sourceEndOffsetBytesExclusive":3,"sourceOffsetBytes":0}]`;
    expect(calculateEndpointEmbeddingPayloadSetSha256(artifacts)).toBe(
      createHash('sha256').update(pythonCanonical).digest('hex'),
    );
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

  it('reads a regular JSON manifest but rejects a manifest symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unzen-eight-physical-preflight-manifest-'));
    try {
      const target = join(dir, 'manifest-target.json');
      const link = join(dir, 'manifest.json');
      await writeFile(target, JSON.stringify({ status: 'pass' }));
      await expect(readRegularJsonFile(target)).resolves.toEqual({ status: 'pass' });
      await symlink(target, link);
      await expect(readRegularJsonFile(link)).rejects.toThrow(/symbolic link/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('requires a real payload directory and rejects a symlinked directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unzen-eight-physical-preflight-dir-'));
    try {
      const target = join(dir, 'payloads-real');
      const link = join(dir, 'payloads');
      await mkdir(target);
      await expect(assertNonSymlinkDirectory(target)).resolves.toBe(target);
      await symlink(target, link, 'dir');
      await expect(assertNonSymlinkDirectory(link)).rejects.toThrow(/symbolic link/);
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
