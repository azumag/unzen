import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED,
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED,
  buildEndpointEmbeddingEightPhysicalBrowserPlan,
  buildEndpointEmbeddingEightPhysicalRuntimePlan,
  validateEndpointEmbeddingEightPhysicalPreflightReport,
} from '../browser-harness/endpoint-embedding-eight-physical-webgpu/contract.js';
import { compareFloat32Bytes } from '../browser-harness/endpoint-embedding-eight-physical-webgpu/comparison.js';

function validManifest() {
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  return {
    schemaVersion: expected.schemaVersion,
    kind: expected.manifestKind,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    candidatePhysicalArtifactCount: expected.candidatePhysicalArtifactCount,
    executionTileCount: expected.executionTileCount,
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

function validPreflight() {
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  const browserExpected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED;
  const runtimePlan = buildEndpointEmbeddingEightPhysicalRuntimePlan(validManifest());
  return {
    kind: browserExpected.preflightKind,
    schemaVersion: browserExpected.schemaVersion,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    candidatePhysicalArtifactCount: expected.candidatePhysicalArtifactCount,
    sourceGraphSha256: expected.sourceGraphSha256,
    sourceExternalData: { ...expected.sourceExternalData },
    manifestPayloadSetSha256: 'f'.repeat(64),
    graph: {
      file: expected.graphFile,
      bytes: expected.graphBytes,
      sha256: expected.graphSha256,
    },
    payloads: runtimePlan.map((entry, index) => ({
      index,
      file: entry.payloadFile,
      bytes: entry.expectedPayloadBytes,
      sha256: entry.expectedPayloadSha256,
      sourceOffsetBytes: entry.sourceOffsetBytes,
      sourceEndOffsetBytesExclusive: entry.sourceEndOffsetBytesExclusive,
    })),
    runtimePlan: runtimePlan.map((entry) => ({ ...entry })),
    evidenceBoundary: browserExpected.evidenceBoundary,
  };
}

describe('8-physical endpoint embedding ORT WebGPU browser contract', () => {
  it('accepts only the actual-file preflight report and derives deterministic 1:1 browser work', () => {
    const preflight = validPreflight();
    expect(validateEndpointEmbeddingEightPhysicalPreflightReport(preflight)).toBe(preflight);

    const plan = buildEndpointEmbeddingEightPhysicalBrowserPlan(preflight);
    expect(plan.kind).toBe(ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED.browserPlanKind);
    expect(plan.runtimeReportKind).toBe(
      ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED.runtimeReportKind,
    );
    expect(plan.tokenIds).toEqual([
      0, 16031, 16032, 32063, 32064, 48095, 48096, 64127,
      64128, 80159, 80160, 96191, 96192, 112223, 112224, 128255,
    ]);
    expect(plan.tiles).toHaveLength(8);
    expect(plan.tiles.map((tile) => tile.physicalArtifactIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(plan.tiles.every((tile) => tile.artifactByteOffset === 0)).toBe(true);
    expect(plan.tiles.every((tile) => tile.graphExternalDataPath === 'payload-0000.bin')).toBe(true);
    expect(plan.tiles.every((tile) => tile.localTokenIds[0] === 0 && tile.localTokenIds[1] === 16031)).toBe(true);
    expect(plan.sequentialExecution).toEqual({
      physicalArtifactOrder: [0, 1, 2, 3, 4, 5, 6, 7],
      tilesPerPhysicalArtifact: 1,
      maximumWholePhysicalPayloadBytesPerStep: 131334144,
      totalPhysicalPayloadBytesVerifiedAcrossRun: 1050673152,
    });
  });

  it.each([
    ['non-pass preflight', (report: any) => { report.status = 'fail'; }],
    ['architecture selection', (report: any) => { report.selectedPhysicalArtifactCount = 8; }],
    ['decision drift', (report: any) => { report.decisionStatus = 'approved'; }],
    ['evidence-boundary drift', (report: any) => { report.evidenceBoundary = 'browser-runtime'; }],
    ['graph drift', (report: any) => { report.graph.sha256 = '0'.repeat(64); }],
    ['payload drift', (report: any) => { report.payloads[4].sha256 = '0'.repeat(64); }],
    ['runtime routing drift', (report: any) => { report.runtimePlan[6].physicalArtifactIndex = 5; }],
    ['non-zero graph offset', (report: any) => { report.runtimePlan[2].artifactByteOffset = 1; }],
  ])('fails closed on %s', (_name, mutate) => {
    const report = validPreflight();
    mutate(report);
    expect(() => validateEndpointEmbeddingEightPhysicalPreflightReport(report)).toThrow();
  });

  it('rejects malformed preflight payload-set identity before browser planning', () => {
    const report = validPreflight();
    report.manifestPayloadSetSha256 = 'not-a-sha';
    expect(() => buildEndpointEmbeddingEightPhysicalBrowserPlan(report)).toThrow(/manifestPayloadSetSha256/);
  });
});

describe('8-physical endpoint byte-exact comparison', () => {
  it('accepts byte-identical Float32 output', () => {
    const actual = new Float32Array([1.25, -3.5, 0]);
    const expected = new Float32Array(actual);
    expect(compareFloat32Bytes(actual, expected)).toEqual({
      exactEqual: true,
      firstByteMismatch: -1,
      maxAbsDiff: 0,
      worstIndex: -1,
    });
  });

  it('rejects +0 versus -0 even though numeric equality would accept them', () => {
    const comparison = compareFloat32Bytes(new Float32Array([0]), new Float32Array([-0]));
    expect(comparison.exactEqual).toBe(false);
    expect(comparison.firstByteMismatch).toBeGreaterThanOrEqual(0);
    expect(comparison.maxAbsDiff).toBe(0);
  });

  it('fails closed on comparison geometry or type drift', () => {
    expect(() => compareFloat32Bytes(new Float32Array([1]), new Float32Array([1, 2])))
      .toThrow(/length mismatch/);
    expect(() => compareFloat32Bytes(new Float32Array([1]), [1] as any))
      .toThrow(/Float32Array inputs/);
  });
});

it('keeps the 8-physical browser runner WebGPU-only, re-verifying bytes, exact, and release-aware', () => {
  const runner = readFileSync(
    new URL('../browser-harness/endpoint-embedding-eight-physical-webgpu/runner.js', import.meta.url),
    'utf8',
  );
  expect(runner).toContain("executionProviders: ['webgpu']");
  expect(runner).toContain("fetch('./data/preflight.json'");
  expect(runner).toContain('buildEndpointEmbeddingEightPhysicalBrowserPlan(preflight)');
  expect(runner).toContain('loadVerified(');
  expect(runner).toContain('referenceEmbedding(');
  expect(runner).toContain('compareFloat32Bytes(');
  expect(runner).toContain('await session.release();');
  expect(runner).toContain('completeEmbeddingComparison');
  expect(runner).toContain('window.__unzenEndpointEmbeddingEightPhysicalWebGpuReport = report;');
  expect(runner).not.toContain('offsetHalf');
});

it('refuses to start the diagnostic server before validating the preflight report', () => {
  const server = readFileSync(
    new URL('../browser-harness/endpoint-embedding-eight-physical-webgpu/serve.mjs', import.meta.url),
    'utf8',
  );
  expect(server).toContain("if (!PREFLIGHT_REPORT) throw new Error('PREFLIGHT_REPORT is required')");
  expect(server).toContain("if (!GRAPH_PATH) throw new Error('GRAPH_PATH is required')");
  const validation = server.indexOf(
    'const preflight = validateEndpointEmbeddingEightPhysicalPreflightReport(',
  );
  const listenableServer = server.indexOf('const server = createServer(');
  expect(validation).toBeGreaterThanOrEqual(0);
  expect(listenableServer).toBeGreaterThan(validation);
});
