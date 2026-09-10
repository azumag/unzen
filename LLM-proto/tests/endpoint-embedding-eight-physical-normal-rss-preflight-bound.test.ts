import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED,
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED,
} from '../browser-harness/endpoint-embedding-eight-physical-webgpu/contract.js';
import {
  assertNormalRuntimeMatchesPreflight,
  buildBoundNormalRssEvidence,
} from '../tools/capture_endpoint_embedding_eight_physical_webgpu_process_rss_bound.mjs';
import { calculateEndpointEmbeddingPayloadSetSha256 } from '../tools/preflight_endpoint_embedding_eight_physical_bundle.mjs';
import { validateBoundNormalRssEvidence } from '../tools/verify_endpoint_embedding_eight_physical_webgpu_process_rss_bound.mjs';

function payloadSha(index: number) {
  return (index + 1).toString(16).padStart(64, '0');
}

function validPreflightReport() {
  const expected = ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED;
  const payloads = Array.from({ length: expected.candidatePhysicalArtifactCount }, (_, index) => ({
    index,
    file: `payload-${String(index).padStart(4, '0')}.bin`,
    bytes: expected.tileBytes,
    sha256: payloadSha(index),
    sourceOffsetBytes: index * expected.tileBytes,
    sourceEndOffsetBytesExclusive: (index + 1) * expected.tileBytes,
  }));
  const runtimePlan = payloads.map((payload, index) => ({
    tileIndex: index,
    startRow: index * expected.rowsPerTile,
    endRowExclusive: (index + 1) * expected.rowsPerTile,
    physicalArtifactIndex: index,
    payloadFile: payload.file,
    expectedPayloadBytes: payload.bytes,
    expectedPayloadSha256: payload.sha256,
    sourceOffsetBytes: payload.sourceOffsetBytes,
    sourceEndOffsetBytesExclusive: payload.sourceEndOffsetBytesExclusive,
    graphFile: expected.graphFile,
    expectedGraphBytes: expected.graphBytes,
    expectedGraphSha256: expected.graphSha256,
    graphExternalDataPath: expected.graphExternalDataPath,
    artifactByteOffset: 0,
    byteLength: expected.tileBytes,
  }));

  return {
    kind: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED.preflightKind,
    schemaVersion: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED.schemaVersion,
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    candidatePhysicalArtifactCount: expected.candidatePhysicalArtifactCount,
    sourceGraphSha256: expected.sourceGraphSha256,
    sourceExternalData: { ...expected.sourceExternalData },
    manifestPayloadSetSha256: calculateEndpointEmbeddingPayloadSetSha256(payloads),
    graph: {
      file: expected.graphFile,
      bytes: expected.graphBytes,
      sha256: expected.graphSha256,
    },
    payloads,
    runtimePlan,
    evidenceBoundary: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED.evidenceBoundary,
    conclusion: 'fixture preflight',
  };
}

function snapshot(totalRssKiB: number, browserRssKiB: number, gpuRssKiB: number) {
  if (browserRssKiB + gpuRssKiB !== totalRssKiB) throw new Error('fixture RSS total mismatch');
  return {
    processCount: 2,
    totalRssKiB,
    roles: {
      browser: { processCount: 1, rssKiB: browserRssKiB },
      'gpu-process': { processCount: 1, rssKiB: gpuRssKiB },
    },
  };
}

function runtimeReport(preflight = validPreflightReport()) {
  const verifiedPhysicalArtifacts = preflight.payloads.map((payload) => ({
    index: payload.index,
    file: payload.file,
    bytes: payload.bytes,
    sha256: payload.sha256,
  }));
  const executedTiles = verifiedPhysicalArtifacts.map((artifact, index) => ({
    tileIndex: index,
    physicalArtifactIndex: index,
    payloadFile: artifact.file,
    payloadSha256: artifact.sha256,
    artifactByteOffset: 0,
    byteLength: artifact.bytes,
    comparison: {
      exactEqual: true,
      firstByteMismatch: -1,
      maxAbsDiff: 0,
      worstIndex: -1,
    },
    sessionCreateMs: 10 + index,
    runMs: 2 + index,
    sessionReleaseMs: 1 + index,
  }));
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-pinned-llama-1b-endpoint-embedding-eight-physical-ort-webgpu-runtime',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    selectedPhysicalArtifactCount: null,
    evidenceLevel: 'self-reported-runtime',
    onnxruntimeWebVersion: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED.onnxruntimeWebVersion,
    manifestPayloadSetSha256: preflight.manifestPayloadSetSha256,
    verifiedGraph: { ...preflight.graph },
    verifiedPhysicalArtifacts,
    executedTiles,
    completeEmbeddingComparison: {
      exactEqual: true,
      firstByteMismatch: -1,
      maxAbsDiff: 0,
      worstIndex: -1,
    },
    outputShape: [16, 2048],
    sequentialExecution: {
      tilesPerPhysicalArtifact: 1,
    },
    sessionReleaseApiCompleted: true,
  };
}

function validEvidence(preflight = validPreflightReport()) {
  const baseline = snapshot(1000, 700, 300);
  const globalPeak = snapshot(2500, 2200, 300);
  const executionPeak = snapshot(2200, 1300, 900);
  const releaseImmediate = snapshot(2100, 1400, 700);
  const releasePeak = snapshot(2300, 1500, 800);
  const releaseFinal = snapshot(2000, 1500, 500);
  const teardownImmediate = snapshot(1500, 1100, 400);
  const teardownPeak = snapshot(1600, 1150, 450);
  const teardownMinimum = snapshot(900, 650, 250);
  const teardownFinal = snapshot(950, 680, 270);
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-endpoint-embedding-eight-physical-webgpu-process-rss-diagnostic',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'captured-os-process-rss',
    capturedAtUtc: '2026-09-10T07:55:00.000Z',
    environment: {
      platform: 'linux',
      osRelease: '6.8.0-test',
      hostTotalMemoryBytes: 16 * 1024 * 1024 * 1024,
      chromeVersion: 'Google Chrome 152.0.8123.45',
      nodeVersion: 'v24.0.0',
      cdpBrowser: 'HeadlessChrome/152.0.8123.45',
    },
    measurement: {
      metric: 'resident-set-size',
      unit: 'KiB',
      aggregation: 'sum of launched Chrome root process and descendants discovered by PPID',
      sampleIntervalMs: 100,
      sampleCount: 20,
      postReportSettleMs: 5000,
      postDocumentTeardownSettleMs: 30000,
      baseline,
      globalPeak,
      phasePeaks: [
        { phase: 'baseline-about-blank', ...baseline },
        { phase: 'executing embedding tile 4', ...executionPeak },
        { phase: 'post-report-release-settle', ...releasePeak },
        { phase: 'post-teardown-about-blank', ...teardownPeak },
      ],
      afterAllSessionReleaseApisReturned: {
        immediate: releaseImmediate,
        peakDuringSettle: releasePeak,
        finalAfterSettle: releaseFinal,
      },
      afterDocumentTeardown: {
        action: 'navigate measured page to about:blank after the release settle window',
        baselineRssKiB: baseline.totalRssKiB,
        immediateAfterBlankReady: teardownImmediate,
        peakDuringSettle: teardownPeak,
        minimumDuringSettle: teardownMinimum,
        firstAtOrBelowBaseline: { elapsedMs: 2500, ...teardownMinimum },
        finalAfterSettle: teardownFinal,
      },
    },
    runtimeReport: runtimeReport(preflight),
    conclusion: 'diagnostic-only normal-completion RSS evidence',
    limitations: ['RSS is not direct GPU allocator accounting.'],
  };
}

describe('8-physical normal RSS preflight provenance binding', () => {
  it('binds a completed runtime report to the exact validated preflight identity', () => {
    const preflight = validPreflightReport();
    const evidence = validEvidence(preflight);
    const report = buildBoundNormalRssEvidence(evidence, preflight);

    expect(report).toMatchObject({
      schemaVersion: '1.0.0',
      kind: 'unzen-endpoint-embedding-eight-physical-webgpu-normal-rss-preflight-bound-evidence',
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      evidenceLevel: 'derived-captured-os-process-rss+runtime-report+validated-preflight-bundle-identity',
      runtimeIdentity: {
        manifestPayloadSetSha256: preflight.manifestPayloadSetSha256,
        graph: preflight.graph,
      },
      runtimeVerification: {
        result: 'exact-runtime-report-match-to-validated-preflight-identity',
        graphMatched: true,
        verifiedPhysicalArtifactCount: 8,
        allPhysicalArtifactIdentitiesMatched: true,
        completeEmbeddingByteExact: true,
        sessionReleaseApiCompleted: true,
      },
    });
    expect(report.runtimeIdentity.physicalArtifacts).toHaveLength(8);
    expect(report.sourceDocuments.processRssEvidenceCanonicalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateBoundNormalRssEvidence(report, evidence, preflight)).toBe(report);
  });

  it('fails closed when runtime graph identity differs from the preflight snapshot', () => {
    const preflight = validPreflightReport();
    const evidence: any = validEvidence(preflight);
    evidence.runtimeReport.verifiedGraph.sha256 = 'f'.repeat(64);
    expect(() => assertNormalRuntimeMatchesPreflight(evidence, preflight)).toThrow(
      /runtimeReport\.verifiedGraph\.sha256 does not match validated preflight identity/,
    );
  });

  it('fails closed when any runtime payload identity differs from the preflight snapshot', () => {
    const preflight = validPreflightReport();
    const evidence: any = validEvidence(preflight);
    evidence.runtimeReport.verifiedPhysicalArtifacts[5].sha256 = 'e'.repeat(64);
    evidence.runtimeReport.executedTiles[5].payloadSha256 = 'e'.repeat(64);
    expect(() => assertNormalRuntimeMatchesPreflight(evidence, preflight)).toThrow(
      /verifiedPhysicalArtifacts\[5\]\.sha256 does not match validated preflight identity/,
    );
  });

  it('fails closed when a persisted bound sidecar or source document is changed', () => {
    const preflight = validPreflightReport();
    const evidence = validEvidence(preflight);
    const report: any = buildBoundNormalRssEvidence(evidence, preflight);
    report.runtimeVerification.verifiedPhysicalArtifactCount = 7;
    expect(() => validateBoundNormalRssEvidence(report, evidence, preflight)).toThrow(
      /does not exactly match validated source documents/,
    );

    const changedPreflight: any = structuredClone(preflight);
    changedPreflight.payloads[0].sha256 = 'd'.repeat(64);
    expect(() => validateBoundNormalRssEvidence(
      buildBoundNormalRssEvidence(evidence, preflight),
      evidence,
      changedPreflight,
    )).toThrow();
  });
});
