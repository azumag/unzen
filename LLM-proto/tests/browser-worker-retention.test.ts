import { describe, expect, it } from 'vitest';
import {
  createDefaultBrowserRetentionManifest,
  measureBrowserWorkerRetention,
  type BrowserRetentionMeasurementManifest,
} from '../src/browser-worker-retention.js';
import { WorkerTier } from '../src/types.js';

describe('browser worker retention measurement gate', () => {
  it('reports session distribution, retention curve, tier split, and adaptive telemetry comparison', () => {
    const report = measureBrowserWorkerRetention(createDefaultBrowserRetentionManifest());

    expect(report.status).toBe('pass');
    expect(report.sessionCount).toBe(10);
    expect(report.durationDistribution).toEqual({
      minMs: 90_000,
      p50Ms: 720_000,
      p95Ms: 43_200_000,
      maxMs: 43_200_000,
    });
    expect(report.retentionCurve).toContainEqual({
      windowMs: 2 * 60 * 1000,
      retainedCount: 9,
      retentionRate: 0.9,
    });
    expect(report.earlyAbandonRate).toBe(0.1);
    expect(report.retryResumeImpact).toEqual({
      abandonedDuringSegmentCount: 1,
      retryCount: 1,
      resumeCount: 1,
      estimatedDelayMs: 457,
      affectedSegments: [1],
    });
    expect(report.tierBreakdown).toContainEqual({
      tier: WorkerTier.TIER_3,
      sessionCount: 5,
      p50Ms: 360_000,
      p95Ms: 720_000,
      earlyAbandonRate: 0.2,
      retentionAtSegmentEnd: 1,
    });
    expect(report.adaptiveTelemetryComparison).toMatchObject({
      observedMedianUptimeMs: 720_000,
      observedFailureRate: 0.1,
      observedHeartbeatJitterP95Ms: 190,
      baselineUptimeMs: 7_200_000,
      baselineFailureRate: 0.1,
      baselineHeartbeatJitterMs: 750,
      uptimeDeltaMs: -6_480_000,
      failureRateDelta: 0,
      heartbeatJitterDeltaMs: -560,
    });
    expect(report.failureReason).toBeUndefined();
  });

  it('keeps Tier 1/2 long-lived workers separate from Tier 3 browser visitors', () => {
    const report = measureBrowserWorkerRetention(createDefaultBrowserRetentionManifest());

    expect(report.tierBreakdown.map((breakdown) => breakdown.tier)).toEqual([
      WorkerTier.TIER_1,
      WorkerTier.TIER_2,
      WorkerTier.TIER_3,
    ]);
    expect(report.tierBreakdown.find((breakdown) => breakdown.tier === WorkerTier.TIER_1)).toMatchObject({
      sessionCount: 2,
      p50Ms: 28_800_000,
      p95Ms: 43_200_000,
      earlyAbandonRate: 0,
      retentionAtSegmentEnd: 1,
    });
    expect(report.tierBreakdown.find((breakdown) => breakdown.tier === WorkerTier.TIER_2)).toMatchObject({
      sessionCount: 3,
      p50Ms: 3_840_000,
      p95Ms: 7_200_000,
      earlyAbandonRate: 0,
      retentionAtSegmentEnd: 1,
    });
  });

  it('fails when early browser abandonment exceeds the scale-up gate', () => {
    const base = createDefaultBrowserRetentionManifest();
    const manifest: BrowserRetentionMeasurementManifest = {
      ...base,
      sessions: [
        ...base.sessions,
        {
          workerId: 't3-bounce-a',
          tier: WorkerTier.TIER_3,
          sessionDurationMs: 45_000,
          heartbeatJitterMs: 220,
        },
        {
          workerId: 't3-bounce-b',
          tier: WorkerTier.TIER_3,
          sessionDurationMs: 75_000,
          heartbeatJitterMs: 260,
        },
      ],
      maxEarlyAbandonRate: 0.2,
    };

    const report = measureBrowserWorkerRetention(manifest);

    expect(report.status).toBe('fail');
    expect(report.earlyAbandonRate).toBe(0.25);
    expect(report.failureReason).toBe('early-abandon-rate-exceeded: 0.25 exceeds 0.2');
  });

  it('fails when segment-time retention cannot keep normal chunk assignment stable', () => {
    const base = createDefaultBrowserRetentionManifest();
    const manifest: BrowserRetentionMeasurementManifest = {
      ...base,
      sessions: [
        {
          workerId: 'visitor-fast-close',
          tier: WorkerTier.TIER_3,
          sessionDurationMs: 2_000,
          heartbeatJitterMs: 150,
        },
        {
          workerId: 'visitor-stable',
          tier: WorkerTier.TIER_3,
          sessionDurationMs: 60_000,
          heartbeatJitterMs: 110,
        },
      ],
      retentionWindowsMs: [4_000],
      maxEarlyAbandonRate: 1,
      minRetentionAtSegmentEnd: 0.75,
    };

    const report = measureBrowserWorkerRetention(manifest);

    expect(report.status).toBe('fail');
    expect(report.retentionCurve).toEqual([
      {
        windowMs: 4_000,
        retainedCount: 1,
        retentionRate: 0.5,
      },
    ]);
    expect(report.failureReason).toBe('segment-retention-below-threshold: 0.5 below 0.75');
  });

  it('fails when segment abandonment creates too much checkpoint resume delay', () => {
    const base = createDefaultBrowserRetentionManifest();
    const manifest: BrowserRetentionMeasurementManifest = {
      ...base,
      sessions: base.sessions.map((session, index) => index < 5
        ? {
          ...session,
          disconnectedDuringSegment: index,
        }
        : {
          ...session,
          disconnectedDuringSegment: undefined,
        }),
      maxRetryResumeImpactMs: 2_000,
    };

    const report = measureBrowserWorkerRetention(manifest);

    expect(report.status).toBe('fail');
    expect(report.retryResumeImpact).toMatchObject({
      abandonedDuringSegmentCount: 5,
      retryCount: 5,
      resumeCount: 5,
      estimatedDelayMs: 2_285,
      affectedSegments: [0, 1, 2, 3, 4],
    });
    expect(report.failureReason).toBe('retry-resume-impact-exceeded: 2285ms exceeds 2000ms');
  });
});
