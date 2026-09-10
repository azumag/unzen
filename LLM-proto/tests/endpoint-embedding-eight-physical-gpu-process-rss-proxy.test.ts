import { describe, expect, it } from 'vitest';
import { deriveGpuProcessRssProxy } from '../tools/derive_endpoint_embedding_eight_physical_gpu_process_rss_proxy.mjs';

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

function validEvidence() {
  const baseline = snapshot(1000, 700, 300);
  const globalPeak = snapshot(2000, 1200, 800);
  const beforeCancellation = snapshot(1800, 1100, 700);
  const immediateAfterBlankReady = snapshot(1600, 1000, 600);
  const peakDuringSettle = snapshot(1700, 1000, 700);
  const minimumDuringSettle = snapshot(900, 650, 250);
  const finalAfterSettle = snapshot(950, 680, 270);
  return {
    schemaVersion: '1.0.0',
    kind: 'unzen-endpoint-embedding-eight-physical-webgpu-page-teardown-cancel-rss-diagnostic',
    status: 'pass',
    decisionStatus: 'diagnostic-only',
    evidenceLevel: 'captured-os-process-rss-after-page-teardown-cancellation',
    capturedAtUtc: '2026-09-10T01:00:00.000Z',
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

describe('8-physical Chrome GPU-process RSS proxy derivation', () => {
  it('derives a deterministic diagnostic-only GPU-process RSS proxy', () => {
    const report = deriveGpuProcessRssProxy(validEvidence());
    expect(report).toMatchObject({
      schemaVersion: '1.0.0',
      kind: 'unzen-endpoint-embedding-eight-physical-webgpu-gpu-process-rss-proxy',
      status: 'pass',
      decisionStatus: 'diagnostic-only',
      evidenceLevel: 'derived-os-gpu-process-rss-proxy',
      sourceEvidence: {
        targetTile: 3,
        expectedPhase: 'executing embedding tile 3',
        capturedAtUtc: '2026-09-10T01:00:00.000Z',
      },
      measurement: {
        baselineRssKiB: 300,
        observedPointPeak: {
          rssKiB: 800,
          deltaFromBaselineKiB: 500,
        },
        postCancelMinimumRssKiB: 250,
        postCancelMinimumDeltaFromBaselineKiB: -50,
        postCancelFinalRssKiB: 270,
        postCancelFinalDeltaFromBaselineKiB: -30,
        peakExcessRecoveryRatioAtPostCancelMinimum: 1.1,
        postCancelMinimumAtOrBelowBaseline: true,
      },
    });
    expect(report.measurement.points).toHaveLength(9);
    expect(report.limitations.join(' ')).toMatch(/not GPU VRAM/);
  });

  it('fails closed when a trusted RSS snapshot has no gpu-process role', () => {
    const evidence: any = validEvidence();
    delete evidence.measurement.baseline.roles['gpu-process'];
    evidence.measurement.baseline.roles.browser = { processCount: 2, rssKiB: 1000 };
    evidence.measurement.phasePeaks[0].processCount = 2;
    expect(() => deriveGpuProcessRssProxy(evidence)).toThrow(/must contain a gpu-process role/);
  });

  it('fails closed when more than one gpu-process is represented', () => {
    const evidence: any = validEvidence();
    evidence.measurement.baseline.processCount = 3;
    evidence.measurement.phasePeaks[0].processCount = 3;
    evidence.measurement.baseline.roles['gpu-process'].processCount = 2;
    expect(() => deriveGpuProcessRssProxy(evidence)).toThrow(/processCount must be exactly 1/);
  });

  it('does not mistake the total-Chrome-tree RSS peak snapshot for the GPU-process RSS peak', () => {
    const evidence: any = validEvidence();
    evidence.measurement.globalPeak.roles.browser.rssKiB = 1500;
    evidence.measurement.globalPeak.roles['gpu-process'].rssKiB = 500;
    evidence.measurement.immediatelyBeforeCancellation.roles.browser.rssKiB = 900;
    evidence.measurement.immediatelyBeforeCancellation.roles['gpu-process'].rssKiB = 900;

    const report = deriveGpuProcessRssProxy(evidence);
    expect(report.measurement.observedPointPeak).toEqual({
      label: 'immediately-before-cancellation',
      rssKiB: 900,
      deltaFromBaselineKiB: 600,
    });
  });

  it('keeps recovery ratio null when no persisted GPU-process point rises above baseline', () => {
    const evidence: any = validEvidence();
    for (const entry of [
      evidence.measurement.globalPeak,
      evidence.measurement.phasePeaks[1],
      evidence.measurement.immediatelyBeforeCancellation,
      evidence.measurement.afterDocumentCancellation.immediateAfterBlankReady,
      evidence.measurement.afterDocumentCancellation.peakDuringSettle,
      evidence.measurement.afterDocumentCancellation.minimumDuringSettle,
      evidence.measurement.afterDocumentCancellation.finalAfterSettle,
      evidence.measurement.afterDocumentCancellation.firstAtOrBelowBaseline,
    ]) {
      const gpu = Math.min(entry.roles['gpu-process'].rssKiB, 300);
      entry.roles.browser.rssKiB = entry.totalRssKiB - gpu;
      entry.roles['gpu-process'].rssKiB = gpu;
    }
    const report = deriveGpuProcessRssProxy(evidence);
    expect(report.measurement.observedPointPeak.rssKiB).toBe(300);
    expect(report.measurement.peakExcessRecoveryRatioAtPostCancelMinimum).toBeNull();
  });
});
