import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateEndpointEmbeddingRuntimeReport } from '../tools/capture_endpoint_embedding_webgpu_runtime.mjs';

function validReport() {
  const tokenIds = [0,16031,16032,32063,32064,48095,48096,64127,64128,80159,80160,96191,96192,112223,112224,128255];
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-embedding-tiled-ort-webgpu-runtime',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'self-reported-runtime',
    onnxruntimeWebVersion: '1.22.0',
    sourceGraphSha256: 'a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46',
    sourceExternalData: { bytes: 1_692_672_000, sha256: '07cc629ef2cb7fdb18615ce2e4f3774f763e6fc840207d772a8b511eead36647' },
    tokenIds,
    verifiedPhysicalArtifacts: [0,1,2,3].map((index) => ({ index })),
    executedTiles: Array.from({ length: 8 }, (_, tileIndex) => ({
      tileIndex,
      physicalArtifactIndex: Math.floor(tileIndex / 2),
      comparison: { exactEqual: true, maxAbsDiff: 0 },
      sessionCreateMs: 1,
      runMs: 1,
      sessionReleaseMs: 1,
    })),
    completeEmbeddingComparison: { exactEqual: true, maxAbsDiff: 0 },
    outputShape: [16, 2048],
    sessionReleaseApiCompleted: true,
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

it('keeps the capture helper isolated-profile, WebGPU-enabled, and create-only for evidence output', () => {
  const source = readFileSync(new URL('../tools/capture_endpoint_embedding_webgpu_runtime.mjs', import.meta.url), 'utf8');
  expect(source).toContain("mkdtempSync(join(tmpdir(), 'unzen-endpoint-embedding-webgpu-'))");
  expect(source).toContain("'--enable-unsafe-webgpu'");
  expect(source).toContain("writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\\n`, { flag: 'wx' })");
  expect(source).toContain("evidenceLevel: 'captured-browser-runtime'");
});
