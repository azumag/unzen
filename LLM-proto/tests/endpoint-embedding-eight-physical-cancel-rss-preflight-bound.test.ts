import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_BROWSER_EXPECTED,
  ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED,
} from '../browser-harness/endpoint-embedding-eight-physical-webgpu/contract.js';
import {
  buildBoundCancellationRssEvidence,
  canonicalJsonSha256,
  endpointEmbeddingEightPhysicalPreflightIdentity,
} from '../tools/capture_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';
import { deriveBoundGpuProcessRssProxy } from '../tools/derive_endpoint_embedding_eight_physical_bound_gpu_process_rss_proxy.mjs';
import { calculateEndpointEmbeddingPayloadSetSha256 } from '../tools/preflight_endpoint_embedding_eight_physical_bundle.mjs';
import { validateBoundCancellationRssEvidence } from '../tools/verify_endpoint_embedding_eight_physical_webgpu_cancel_rss_bound.mjs';

function snapshot(totalRssKiB: number) {
  const gpuRssKiB = Math.max(1, Math.floor(totalRssKiB / 3));
  const browserRssKiB = totalRssKiB - gpuRssKiB;
  return {
    processCount: 2,
    totalRssKiB,
    roles: {
      browser: { processCount: 1, rssKiB: browserRssKiB },
      'gpu-process': { processCount: 1, rssKiB: gpuRssKiB },
    },
  };
}

function validCancellationEvidence() {
  const baseline = snapshot(100);
  const globalPeak = snapshot(200);
  const beforeCancellation = snapshot(180);
  const immediateAfterBlankReady = snapshot(160);
  const peakDuringSettle = snapshot(170);
  const minimumDuringSettle = snapshot(90);
  const finalAfterSettle = snapshot(95);
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-endpoint-embedding-eight-physical-webgpu-page-teardown-cancel-rss-diagnostic',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'captured-os-process-rss-after-page-teardown-cancellation',
    capturedAtUtc: '2026-09-10T06:30:00.000Z',
    environment: {
      platform: 'linux',
      osRelease: '6.8.0-test',
      hostTotalMemoryBytes: 16 * 1024 * 1024 * 1024,
      chromeVersion: 'Google Chrome 152.0.8123.45',
      nodeVersion: 'v24.0.0',
      cdpBrowser: 'HeadlessChrome/152.0.8123.45',
    },
    cancellation: {
      targetTile: 3,
      expectedPhase: 'executing embedding tile 3',
      observedPhase: 'executing embedding tile 3',
      reportStatusAtTrigger: null,
      method: 'CDP Page.navigate to about:blank',
      requestToBlankReadyMs: 42,
      boundary: 'coarse page teardown after observing the runner phase; exact ORT progress is not asserted',
    },
    measurement: {
      metric: 'resident-set-size',
      unit: 'KiB',
      aggregation: 'sum of launched Chrome root process and descendants discovered by PPID',
      sampleIntervalMs: 100,
      sampleCount: 12,
      postCancelSettleMs: 30000,
      baseline,
      globalPeak,
      phasePeaks: [
        { phase: 'baseline-about-blank', ...baseline },
        { phase: 'executing embedding tile 3', ...globalPeak },
        { phase: 'post-cancel-about-blank', ...peakDuringSettle },
      ],
      immediatelyBeforeCancellation: beforeCancellation,
      afterDocumentCancellation: {
        action: 'navigate measured page to about:blank as a coarse cancellation boundary',
        baselineRssKiB: baseline.totalRssKiB,
        immediateAfterBlankReady,
        peakDuringSettle,
        minimumDuringSettle,
        firstAtOrBelowBaseline: { elapsedMs: 2500, ...minimumDuringSettle },
        finalAfterSettle,
      },
    },
    conclusion: 'diagnostic-only cancellation RSS evidence',
    limitations: ['RSS is not direct GPU allocator accounting.'],
  };
}

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

describe('8-physical cancellation RSS preflight provenance binding', () => {
  it('preserves and revalidates an exact runtime identity for later normal/cancel comparison', () => {
    const preflight = validPreflightReport();
    const cancellation = validCancellationEvidence();
    const report = buildBoundCancellationRssEvidence(cancellation, preflight);

    expect(report).toMatchObject({
      schemaVersion: '1.0.0',
      kind: 'unzen-endpoint-embedding-eight-physical-webgpu-cancel-rss-preflight-bound-evidence',
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      evidenceLevel: 'derived-captured-os-process-rss+validated-preflight-bundle-identity',
      cancellation: {
        targetTile: 3,
        expectedPhase: 'executing embedding tile 3',
      },
      runtimeIdentity: {
        identitySource: 'validated-preflight-report-snapshot-supplied-to-harness',
        onnxruntimeWebVersion: '1.22.0',
        manifestPayloadSetSha256: preflight.manifestPayloadSetSha256,
        graph: {
          file: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED.graphFile,
          bytes: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED.graphBytes,
          sha256: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED.graphSha256,
        },
      },
    });
    expect(report.runtimeIdentity.physicalArtifacts).toHaveLength(8);
    expect(report.runtimeIdentity.physicalArtifacts[7]).toMatchObject({
      index: 7,
      file: 'payload-0007.bin',
      sha256: payloadSha(7),
      sourceEndOffsetBytesExclusive: ENDPOINT_EMBEDDING_EIGHT_PHYSICAL_EXPECTED.totalEmbeddingBytes,
    });
    expect(report.sourceDocuments.cancellationEvidenceCanonicalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.sourceDocuments.preflightReportCanonicalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateBoundCancellationRssEvidence(report, cancellation, preflight)).toBe(report);

    const gpuProxy = deriveBoundGpuProcessRssProxy(cancellation, report, preflight);
    expect(gpuProxy).toMatchObject({
      schemaVersion: '1.1.0',
      kind: 'unzen-endpoint-embedding-eight-physical-webgpu-preflight-bound-gpu-process-rss-proxy',
      decisionStatus: 'diagnostic-only',
      evidenceLevel: 'derived-os-gpu-process-rss-proxy+validated-preflight-bundle-identity',
      sourceEvidence: {
        runtimeIdentity: {
          manifestPayloadSetSha256: preflight.manifestPayloadSetSha256,
        },
      },
    });
  });

  it('uses a key-order-independent canonical digest for source-document identity', () => {
    expect(canonicalJsonSha256({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJsonSha256({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('fails closed when preflight graph, payload, or payload-set identity drifts', () => {
    const badGraph: any = validPreflightReport();
    badGraph.graph.sha256 = 'b'.repeat(64);
    expect(() => endpointEmbeddingEightPhysicalPreflightIdentity(badGraph)).toThrow(/preflight.graph.sha256 contract mismatch/);

    const badPayload: any = validPreflightReport();
    badPayload.payloads[2].sha256 = 'NOT-A-DIGEST';
    expect(() => buildBoundCancellationRssEvidence(validCancellationEvidence(), badPayload)).toThrow(
      /canonical lowercase SHA-256/,
    );

    const badPayloadSet: any = validPreflightReport();
    badPayloadSet.manifestPayloadSetSha256 = 'f'.repeat(64);
    expect(() => endpointEmbeddingEightPhysicalPreflightIdentity(badPayloadSet)).toThrow(
      /manifestPayloadSetSha256 does not match preflight.payloads/,
    );
  });

  it('fails closed when cancellation evidence cannot pass the existing verifier', () => {
    const cancellation: any = validCancellationEvidence();
    cancellation.cancellation.observedPhase = 'executing embedding tile 4';
    expect(() => buildBoundCancellationRssEvidence(cancellation, validPreflightReport())).toThrow(/phase mismatch/);
  });

  it('fails closed when a persisted bound sidecar is modified', () => {
    const preflight = validPreflightReport();
    const cancellation = validCancellationEvidence();
    const report: any = buildBoundCancellationRssEvidence(cancellation, preflight);
    report.runtimeIdentity.physicalArtifacts[0].sha256 = 'f'.repeat(64);
    expect(() => validateBoundCancellationRssEvidence(report, cancellation, preflight)).toThrow(
      /does not exactly match validated source documents/,
    );
  });
});
