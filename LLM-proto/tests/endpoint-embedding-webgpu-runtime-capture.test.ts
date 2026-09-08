import { closeSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENDPOINT_EMBEDDING_WEBGPU_EXPECTED } from '../browser-harness/endpoint-embedding-tiled-webgpu/contract.js';
import {
  assertDistinctCapturePorts,
  reserveEvidenceOutput,
  validateCapturedEndpointEmbeddingRuntimeEvidence,
  validateEndpointEmbeddingRuntimeReport,
} from '../tools/capture_endpoint_embedding_webgpu_runtime.mjs';

function validReport() {
  const expected = ENDPOINT_EMBEDDING_WEBGPU_EXPECTED;
  return {
    schemaVersion: expected.schemaVersion,
    kind: expected.runtimeReportKind,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'self-reported-runtime',
    onnxruntimeWebVersion: expected.onnxruntimeWebVersion,
    sourceGraphSha256: expected.sourceGraphSha256,
    sourceExternalData: structuredClone(expected.sourceExternalData),
    embeddingInitializer: structuredClone(expected.embeddingInitializer),
    tokenIds: structuredClone(expected.tokenIds),
    verifiedPhysicalArtifacts: expected.physicalArtifacts.map(({ index, bytes, sha256 }) => ({ index, bytes, sha256 })),
    executedTiles: expected.tiles.map((tile) => ({
      tileIndex: tile.tileIndex,
      startRow: tile.startRow,
      endRowExclusive: tile.endRowExclusive,
      physicalArtifactIndex: tile.physicalArtifactIndex,
      artifactByteOffset: tile.artifactByteOffset,
      byteLength: tile.byteLength,
      positions: structuredClone(tile.positions),
      globalTokenIds: structuredClone(tile.globalTokenIds),
      localTokenIds: structuredClone(tile.localTokenIds),
      graphVariant: tile.graphVariant,
      comparison: { exactEqual: true, maxAbsDiff: 0 },
      sessionCreateMs: 1,
      runMs: 1,
      sessionReleaseMs: 1,
    })),
    completeEmbeddingComparison: { exactEqual: true, maxAbsDiff: 0 },
    outputShape: [expected.tokenIds.length, expected.hiddenSize],
    sequentialExecution: structuredClone(expected.sequentialExecution),
    sessionReleaseApiCompleted: true,
  };
}

function validCapturedEvidence() {
  return {
    ...validReport(),
    evidenceLevel: 'captured-browser-runtime',
    capturedAtUtc: '2026-09-09T00:00:00.000Z',
    captureEnvironment: {
      chromeVersion: 'Google Chrome 152.0.7977.83',
      cdpBrowser: 'Chrome/152.0.7977.83',
      nodeVersion: 'v24.8.0',
      platform: 'darwin',
    },
  };
}

describe('endpoint embedding WebGPU capture report validator', () => {
  it('accepts the pinned complete embedding runtime report', () => {
    const report = validReport();
    expect(validateEndpointEmbeddingRuntimeReport(report)).toBe(report);
  });

  it.each([
    ['decision promotion', (report: any) => { report.decisionStatus = 'approved'; }],
    ['source drift', (report: any) => { report.sourceGraphSha256 = '0'.repeat(64); }],
    ['payload digest drift', (report: any) => { report.verifiedPhysicalArtifacts[2].sha256 = '0'.repeat(64); }],
    ['missing tile', (report: any) => { report.executedTiles.pop(); }],
    ['tile routing drift', (report: any) => { report.executedTiles[6].physicalArtifactIndex = 2; }],
    ['numerical mismatch', (report: any) => { report.executedTiles[4].comparison.maxAbsDiff = 1e-5; }],
    ['incomplete release', (report: any) => { report.sessionReleaseApiCompleted = false; }],
  ])('fails closed on %s', (_name, mutate) => {
    const report = validReport();
    mutate(report);
    expect(() => validateEndpointEmbeddingRuntimeReport(report)).toThrow();
  });
});

describe('captured endpoint embedding WebGPU evidence validator', () => {
  it('accepts a capture envelope only when runtime and capture metadata both pass', () => {
    const evidence = validCapturedEvidence();
    expect(validateCapturedEndpointEmbeddingRuntimeEvidence(evidence)).toBe(evidence);
  });

  it.each([
    ['self-reported evidence level', (evidence: any) => { evidence.evidenceLevel = 'self-reported-runtime'; }],
    ['non-canonical timestamp', (evidence: any) => { evidence.capturedAtUtc = '2026-09-09T00:00:00Z'; }],
    ['missing capture environment', (evidence: any) => { delete evidence.captureEnvironment; }],
    ['Chrome/CDP version mismatch', (evidence: any) => { evidence.captureEnvironment.cdpBrowser = 'Chrome/151.0.0.0'; }],
    ['malformed Node version', (evidence: any) => { evidence.captureEnvironment.nodeVersion = 'node-current'; }],
    ['runtime payload drift inside capture', (evidence: any) => { evidence.verifiedPhysicalArtifacts[0].bytes += 1; }],
    ['runtime numerical mismatch inside capture', (evidence: any) => { evidence.completeEmbeddingComparison.exactEqual = false; }],
  ])('fails closed on %s', (_name, mutate) => {
    const evidence = validCapturedEvidence();
    mutate(evidence);
    expect(() => validateCapturedEndpointEmbeddingRuntimeEvidence(evidence)).toThrow();
  });
});

describe('endpoint embedding WebGPU capture preflight', () => {
  it('rejects a shared harness and DevTools port before launch', () => {
    expect(() => assertDistinctCapturePorts(8796, 8796)).toThrow('must be distinct');
    expect(() => assertDistinctCapturePorts(8796, 9228)).not.toThrow();
  });

  it('atomically reserves an evidence path and refuses an existing path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-capture-test-'));
    const outputPath = join(dir, 'evidence.json');
    try {
      const fd = reserveEvidenceOutput(outputPath);
      closeSync(fd);
      expect(() => reserveEvidenceOutput(outputPath)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('keeps the capture helper isolated-profile, WebGPU-enabled, captured-envelope-validated, and reserved-output-only for evidence', () => {
  const source = readFileSync(new URL('../tools/capture_endpoint_embedding_webgpu_runtime.mjs', import.meta.url), 'utf8');
  expect(source).toContain("mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-webgpu-'))");
  expect(source).toContain("'--enable-unsafe-webgpu'");
  expect(source).toContain("openSync(outputPath, 'wx', 0o600)");
  expect(source).toContain('validateCapturedEndpointEmbeddingRuntimeEvidence(evidence)');
  expect(source).toContain('writeFileSync(outputFd, `${JSON.stringify(evidence, null, 2)}\\n`)');
  expect(source).toContain('fsyncSync(outputFd)');
  expect(source).toContain('if (!outputCommitted) { try { unlinkSync(outputPath); } catch {} }');
  expect(source).toContain("evidenceLevel: 'captured-browser-runtime'");
  expect(source.indexOf("await assertPortAvailable(serverPort, 'harness')"))
    .toBeLessThan(source.indexOf("mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-webgpu-'))"));
  expect(source.indexOf('outputFd = reserveEvidenceOutput(outputPath)'))
    .toBeLessThan(source.indexOf("mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-webgpu-'))"));
  expect(source.indexOf('validateCapturedEndpointEmbeddingRuntimeEvidence(evidence)'))
    .toBeLessThan(source.indexOf('writeFileSync(outputFd'));
});

it('keeps an offline verifier wired to the captured-evidence validator', () => {
  const source = readFileSync(new URL('../tools/verify_endpoint_embedding_webgpu_runtime_evidence.mjs', import.meta.url), 'utf8');
  expect(source).toContain('validateCapturedEndpointEmbeddingRuntimeEvidence(evidence)');
  expect(source).toContain("usage: verify_endpoint_embedding_webgpu_runtime_evidence.mjs EVIDENCE_JSON");
});
