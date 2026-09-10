import { describe, expect, it } from 'vitest';
import { deriveNormalGpuProcessRssProxy } from '../tools/derive_endpoint_embedding_eight_physical_normal_gpu_process_rss_proxy.mjs';

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

function runtimeReport() {
  const verifiedPhysicalArtifacts = Array.from({ length: 8 }, (_, index) => ({
    index,
    file: `payload-${String(index).padStart(4, '0')}.bin`,
    bytes: 131_334_144,
    sha256: index.toString(16).repeat(64).slice(0, 64),
  }));
  const executedTiles = verifiedPhysicalArtifacts.map((artifact, index) => ({
    tileIndex: index,
    physicalArtifactIndex: index,
    payloadFile: artifact.file,
    payloadSha256: artifact.sha256,
    artifactByteOffset: 0,
    byteLength: 131_334_144,
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
    onnxruntimeWebVersion: '1.22.0',
    manifestPayloadSetSha256: 'a'.repeat(64),
    verifiedGraph: {
      file: 'embedding-offset-0.onnx',
      bytes: 260,
      sha256: 'b'.repeat(64),
    },
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

function validEvidence() {
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
    capturedAtUtc: '2026-09-10T05:00:00.000Z',
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
    runtimeReport: runtimeReport(),
    conclusion: 'diagnostic-only normal-completion RSS evidence',
    limitations: ['RSS is not direct GPU allocator accounting.'],
  };
}

function rewriteGpu(snapshotValue: any, gpuRssKiB: number) {
  snapshotValue.roles['gpu-process'].rssKiB = gpuRssKiB;
  snapshotValue.roles.browser.rssKiB = snapshotValue.totalRssKiB - gpuRssKiB;
}

describe('8-physical normal-completion Chrome GPU-process RSS proxy derivation', () => {
  it('derives release and teardown proxy observations without promoting a total-RSS peak to GPU peak', () => {
    const report = deriveNormalGpuProcessRssProxy(validEvidence());
    expect(report).toMatchObject({
      schemaVersion: '1.0.0',
      kind: 'unzen-endpoint-embedding-eight-physical-webgpu-normal-gpu-process-rss-proxy',
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      evidenceLevel: 'derived-os-gpu-process-rss-proxy',
      sourceEvidence: {
        capturedAtUtc: '2026-09-10T05:00:00.000Z',
        postReportSettleMs: 5000,
        postDocumentTeardownSettleMs: 30000,
      },
      measurement: {
        baselineRssKiB: 300,
        observedPointPeak: {
          label: 'execution-phase-total-rss-peak',
          phase: 'executing embedding tile 4',
          rssKiB: 900,
          deltaFromBaselineKiB: 600,
        },
        postReleaseFinalRssKiB: 500,
        postReleaseFinalDeltaFromBaselineKiB: 200,
        peakExcessRecoveryRatioAtPostReleaseFinal: 2 / 3,
        postReleaseFinalAtOrBelowBaseline: false,
        postTeardownMinimumRssKiB: 250,
        postTeardownMinimumDeltaFromBaselineKiB: -50,
        peakExcessRecoveryRatioAtPostTeardownMinimum: 650 / 600,
        postTeardownMinimumAtOrBelowBaseline: true,
        postTeardownFinalRssKiB: 270,
        postTeardownFinalDeltaFromBaselineKiB: -30,
      },
    });
    expect(report.measurement.points.map((entry) => entry.label)).toEqual([
      'baseline-about-blank',
      'global-total-rss-peak-snapshot',
      'execution-phase-total-rss-peak',
      'post-release-immediate',
      'post-release-total-rss-peak',
      'post-release-final',
      'post-teardown-immediate',
      'post-teardown-total-rss-peak',
      'post-teardown-total-rss-minimum',
      'post-teardown-final',
      'first-total-rss-at-or-below-baseline',
    ]);
    expect(report.measurement).not.toHaveProperty('postReleaseMinimumRssKiB');
    expect(report.limitations.join(' ')).toMatch(/no release-window minimum/);
  });

  it('fails closed when a trusted RSS snapshot has no gpu-process role', () => {
    const evidence: any = validEvidence();
    for (const target of [evidence.measurement.baseline, evidence.measurement.phasePeaks[0]]) {
      delete target.roles['gpu-process'];
      target.roles.browser = { processCount: 2, rssKiB: target.totalRssKiB };
    }
    expect(() => deriveNormalGpuProcessRssProxy(evidence)).toThrow(/must contain a gpu-process role/);
  });

  it('fails closed when more than one gpu-process is represented', () => {
    const evidence: any = validEvidence();
    for (const target of [evidence.measurement.baseline, evidence.measurement.phasePeaks[0]]) {
      target.processCount = 3;
      target.roles['gpu-process'].processCount = 2;
    }
    expect(() => deriveNormalGpuProcessRssProxy(evidence)).toThrow(/processCount must be exactly 1/);
  });

  it('uses the largest GPU-process RSS among persisted observation points, not the global Chrome-tree peak snapshot', () => {
    const report = deriveNormalGpuProcessRssProxy(validEvidence());
    expect(report.measurement.points.find((entry) => entry.label === 'global-total-rss-peak-snapshot')).toMatchObject({
      rssKiB: 300,
    });
    expect(report.measurement.observedPointPeak).toMatchObject({
      label: 'execution-phase-total-rss-peak',
      rssKiB: 900,
    });
  });

  it('keeps recovery ratios null when no persisted GPU-process point rises above baseline', () => {
    const evidence: any = validEvidence();
    const snapshots = [
      evidence.measurement.globalPeak,
      evidence.measurement.phasePeaks[1],
      evidence.measurement.phasePeaks[2],
      evidence.measurement.phasePeaks[3],
      evidence.measurement.afterAllSessionReleaseApisReturned.immediate,
      evidence.measurement.afterAllSessionReleaseApisReturned.peakDuringSettle,
      evidence.measurement.afterAllSessionReleaseApisReturned.finalAfterSettle,
      evidence.measurement.afterDocumentTeardown.immediateAfterBlankReady,
      evidence.measurement.afterDocumentTeardown.peakDuringSettle,
      evidence.measurement.afterDocumentTeardown.minimumDuringSettle,
      evidence.measurement.afterDocumentTeardown.finalAfterSettle,
      evidence.measurement.afterDocumentTeardown.firstAtOrBelowBaseline,
    ];
    for (const entry of snapshots) rewriteGpu(entry, Math.min(entry.roles['gpu-process'].rssKiB, 300));

    const report = deriveNormalGpuProcessRssProxy(evidence);
    expect(report.measurement.observedPointPeak.rssKiB).toBe(300);
    expect(report.measurement.peakExcessRecoveryRatioAtPostReleaseFinal).toBeNull();
    expect(report.measurement.peakExcessRecoveryRatioAtPostTeardownMinimum).toBeNull();
  });
});
