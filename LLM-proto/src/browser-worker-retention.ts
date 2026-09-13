import type { WorkerTelemetry } from './adaptive-chunk-dispatcher.js';
import { WorkerTier } from './types.js';

export type BrowserRetentionStatus = 'pass' | 'fail';

export interface BrowserWorkerSessionSample {
  readonly workerId: string;
  readonly tier: WorkerTier;
  readonly sessionDurationMs: number;
  readonly heartbeatJitterMs: number;
  readonly disconnectedDuringSegment?: number;
}

export interface BrowserRetentionMeasurementManifest {
  readonly requestId: string;
  readonly sessions: readonly BrowserWorkerSessionSample[];
  readonly segmentDurationMs: number;
  readonly checkpointResumeMs: number;
  readonly retryBackoffMs: number;
  readonly earlyAbandonThresholdMs: number;
  readonly retentionWindowsMs: readonly number[];
  readonly maxEarlyAbandonRate: number;
  readonly minRetentionAtSegmentEnd: number;
  readonly maxRetryResumeImpactMs: number;
  readonly adaptiveTelemetryBaseline: Pick<
    WorkerTelemetry,
    'uptimeMs' | 'failureRate' | 'heartbeatJitterMs'
  >;
}

export interface BrowserRetentionMeasurementReport {
  readonly requestId: string;
  readonly status: BrowserRetentionStatus;
  readonly sessionCount: number;
  readonly tierBreakdown: readonly TierRetentionBreakdown[];
  readonly durationDistribution: {
    readonly minMs: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
  };
  readonly retentionCurve: readonly {
    readonly windowMs: number;
    readonly retainedCount: number;
    readonly retentionRate: number;
  }[];
  readonly earlyAbandonRate: number;
  readonly retryResumeImpact: {
    readonly abandonedDuringSegmentCount: number;
    readonly retryCount: number;
    readonly resumeCount: number;
    readonly estimatedDelayMs: number;
    readonly affectedSegments: readonly number[];
  };
  readonly adaptiveTelemetryComparison: {
    readonly observedMedianUptimeMs: number;
    readonly observedFailureRate: number;
    readonly observedHeartbeatJitterP95Ms: number;
    readonly baselineUptimeMs: number;
    readonly baselineFailureRate: number;
    readonly baselineHeartbeatJitterMs: number;
    readonly uptimeDeltaMs: number;
    readonly failureRateDelta: number;
    readonly heartbeatJitterDeltaMs: number;
  };
  readonly failureReason?: string;
}

export interface TierRetentionBreakdown {
  readonly tier: WorkerTier;
  readonly sessionCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly earlyAbandonRate: number;
  readonly retentionAtSegmentEnd: number;
}

export function createDefaultBrowserRetentionManifest(): BrowserRetentionMeasurementManifest {
  return {
    requestId: 'browser-retention-default',
    sessions: [
      tierSession('t1-signage-a', WorkerTier.TIER_1, 12 * 60 * 60 * 1000, 15),
      tierSession('t1-signage-b', WorkerTier.TIER_1, 8 * 60 * 60 * 1000, 18),
      tierSession('t2-obs-a', WorkerTier.TIER_2, 2 * 60 * 60 * 1000, 25),
      tierSession('t2-extension-a', WorkerTier.TIER_2, 64 * 60 * 1000, 35),
      tierSession('t2-extension-b', WorkerTier.TIER_2, 48 * 60 * 1000, 50),
      tierSession('t3-visitor-a', WorkerTier.TIER_3, 12 * 60 * 1000, 80),
      tierSession('t3-visitor-b', WorkerTier.TIER_3, 9 * 60 * 1000, 95),
      tierSession('t3-visitor-c', WorkerTier.TIER_3, 6 * 60 * 1000, 120),
      tierSession('t3-visitor-d', WorkerTier.TIER_3, 4 * 60 * 1000, 140),
      tierSession('t3-visitor-e', WorkerTier.TIER_3, 90_000, 190, 1),
    ],
    segmentDurationMs: 4_000,
    checkpointResumeMs: 407,
    retryBackoffMs: 50,
    earlyAbandonThresholdMs: 2 * 60 * 1000,
    retentionWindowsMs: [30_000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000],
    maxEarlyAbandonRate: 0.15,
    minRetentionAtSegmentEnd: 0.9,
    maxRetryResumeImpactMs: 2_000,
    adaptiveTelemetryBaseline: {
      uptimeMs: 2 * 60 * 60 * 1000,
      failureRate: 0.1,
      heartbeatJitterMs: 750,
    },
  };
}

export function measureBrowserWorkerRetention(
  manifest: BrowserRetentionMeasurementManifest,
): BrowserRetentionMeasurementReport {
  assertBrowserRetentionMeasurementManifest(manifest);

  const durations = manifest.sessions.map((session) => session.sessionDurationMs).sort(sortNumber);
  const durationDistribution = {
    minMs: durations[0],
    p50Ms: percentileNearestRank(durations, 0.5),
    p95Ms: percentileNearestRank(durations, 0.95),
    maxMs: durations[durations.length - 1],
  };
  const earlyAbandonRate = rate(
    manifest.sessions.filter(
      (session) => session.sessionDurationMs < manifest.earlyAbandonThresholdMs,
    ).length,
    manifest.sessions.length,
  );
  const retentionCurve = manifest.retentionWindowsMs.map((windowMs) => {
    const retainedCount = manifest.sessions.filter(
      (session) => session.sessionDurationMs >= windowMs,
    ).length;
    return {
      windowMs,
      retainedCount,
      retentionRate: rate(retainedCount, manifest.sessions.length),
    };
  });
  const retryResumeImpact = computeRetryResumeImpact(manifest);
  const adaptiveTelemetryComparison = compareWithAdaptiveTelemetry(
    manifest,
    durationDistribution.p50Ms,
  );
  const tierBreakdown = buildTierBreakdown(manifest);
  const failureReason = selectFailureReason(
    manifest,
    earlyAbandonRate,
    retentionCurve,
    retryResumeImpact.estimatedDelayMs,
  );

  return {
    requestId: manifest.requestId,
    status: failureReason ? 'fail' : 'pass',
    sessionCount: manifest.sessions.length,
    tierBreakdown,
    durationDistribution,
    retentionCurve,
    earlyAbandonRate,
    retryResumeImpact,
    adaptiveTelemetryComparison,
    failureReason,
  };
}

function assertBrowserRetentionMeasurementManifest(
  value: unknown,
): asserts value is BrowserRetentionMeasurementManifest {
  assertRecord(value, 'Browser retention manifest');
  if (typeof value.requestId !== 'string') {
    throw new TypeError('Browser retention requestId must be a string');
  }
  if (!Array.isArray(value.sessions)) {
    throw new TypeError('Browser retention sessions must be an array');
  }
  if (value.sessions.length === 0) {
    throw new Error('Browser retention measurement requires at least one session');
  }
  value.sessions.forEach((session, index) => assertSessionSample(session, index));

  assertNonNegativeFinite(value.segmentDurationMs, 'segmentDurationMs');
  assertNonNegativeFinite(value.checkpointResumeMs, 'checkpointResumeMs');
  assertNonNegativeFinite(value.retryBackoffMs, 'retryBackoffMs');
  assertNonNegativeFinite(value.earlyAbandonThresholdMs, 'earlyAbandonThresholdMs');
  assertNonNegativeFinite(value.maxRetryResumeImpactMs, 'maxRetryResumeImpactMs');
  assertRate(value.maxEarlyAbandonRate, 'maxEarlyAbandonRate');
  assertRate(value.minRetentionAtSegmentEnd, 'minRetentionAtSegmentEnd');

  if (!Array.isArray(value.retentionWindowsMs)) {
    throw new TypeError('Browser retention retentionWindowsMs must be an array');
  }
  value.retentionWindowsMs.forEach((windowMs, index) => {
    assertNonNegativeFinite(windowMs, `retentionWindowsMs[${index}]`);
  });

  assertRecord(value.adaptiveTelemetryBaseline, 'Browser retention adaptiveTelemetryBaseline');
  assertNonNegativeFinite(value.adaptiveTelemetryBaseline.uptimeMs, 'adaptiveTelemetryBaseline.uptimeMs');
  assertRate(value.adaptiveTelemetryBaseline.failureRate, 'adaptiveTelemetryBaseline.failureRate');
  assertNonNegativeFinite(
    value.adaptiveTelemetryBaseline.heartbeatJitterMs,
    'adaptiveTelemetryBaseline.heartbeatJitterMs',
  );
}

function assertSessionSample(value: unknown, index: number): asserts value is BrowserWorkerSessionSample {
  assertRecord(value, `Browser retention session[${index}]`);
  if (typeof value.workerId !== 'string') {
    throw new TypeError(`Browser retention session[${index}].workerId must be a string`);
  }
  if (
    value.tier !== WorkerTier.TIER_1
    && value.tier !== WorkerTier.TIER_2
    && value.tier !== WorkerTier.TIER_3
  ) {
    throw new TypeError(`Browser retention session[${index}].tier must be a valid WorkerTier`);
  }
  assertNonNegativeFinite(value.sessionDurationMs, `session[${index}].sessionDurationMs`);
  assertNonNegativeFinite(value.heartbeatJitterMs, `session[${index}].heartbeatJitterMs`);
  if (value.disconnectedDuringSegment !== undefined) {
    if (
      typeof value.disconnectedDuringSegment !== 'number'
      || !Number.isSafeInteger(value.disconnectedDuringSegment)
      || value.disconnectedDuringSegment < 0
    ) {
      throw new TypeError(
        `Browser retention session[${index}].disconnectedDuringSegment must be a non-negative safe integer`,
      );
    }
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertNonNegativeFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`Browser retention ${label} must be a non-negative finite number`);
  }
}

function assertRate(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`Browser retention ${label} must be a finite number between 0 and 1`);
  }
}

function computeRetryResumeImpact(manifest: BrowserRetentionMeasurementManifest) {
  const abandonedDuringSegment = manifest.sessions.filter(
    (session) => session.disconnectedDuringSegment !== undefined,
  );
  const affectedSegments = [...new Set(
    abandonedDuringSegment.map((session) => session.disconnectedDuringSegment as number),
  )].sort(sortNumber);
  const retryCount = abandonedDuringSegment.length;
  const resumeCount = abandonedDuringSegment.length;

  return {
    abandonedDuringSegmentCount: abandonedDuringSegment.length,
    retryCount,
    resumeCount,
    estimatedDelayMs: abandonedDuringSegment.length *
      (manifest.checkpointResumeMs + manifest.retryBackoffMs),
    affectedSegments,
  };
}

function compareWithAdaptiveTelemetry(
  manifest: BrowserRetentionMeasurementManifest,
  observedMedianUptimeMs: number,
) {
  const failures = manifest.sessions.filter(
    (session) => session.sessionDurationMs < manifest.segmentDurationMs ||
      session.disconnectedDuringSegment !== undefined,
  ).length;
  const observedFailureRate = rate(failures, manifest.sessions.length);
  const observedHeartbeatJitterP95Ms = percentileNearestRank(
    manifest.sessions.map((session) => session.heartbeatJitterMs).sort(sortNumber),
    0.95,
  );

  return {
    observedMedianUptimeMs,
    observedFailureRate,
    observedHeartbeatJitterP95Ms,
    baselineUptimeMs: manifest.adaptiveTelemetryBaseline.uptimeMs,
    baselineFailureRate: manifest.adaptiveTelemetryBaseline.failureRate,
    baselineHeartbeatJitterMs: manifest.adaptiveTelemetryBaseline.heartbeatJitterMs,
    uptimeDeltaMs: observedMedianUptimeMs - manifest.adaptiveTelemetryBaseline.uptimeMs,
    failureRateDelta: observedFailureRate - manifest.adaptiveTelemetryBaseline.failureRate,
    heartbeatJitterDeltaMs: observedHeartbeatJitterP95Ms -
      manifest.adaptiveTelemetryBaseline.heartbeatJitterMs,
  };
}

function buildTierBreakdown(
  manifest: BrowserRetentionMeasurementManifest,
): TierRetentionBreakdown[] {
  return [WorkerTier.TIER_1, WorkerTier.TIER_2, WorkerTier.TIER_3]
    .map((tier) => {
      const sessions = manifest.sessions.filter((session) => session.tier === tier);
      if (sessions.length === 0) {
        return null;
      }

      const durations = sessions.map((session) => session.sessionDurationMs).sort(sortNumber);
      const earlyAbandonCount = sessions.filter(
        (session) => session.sessionDurationMs < manifest.earlyAbandonThresholdMs,
      ).length;
      const retainedAtSegmentEnd = sessions.filter(
        (session) => session.sessionDurationMs >= manifest.segmentDurationMs,
      ).length;

      return {
        tier,
        sessionCount: sessions.length,
        p50Ms: percentileNearestRank(durations, 0.5),
        p95Ms: percentileNearestRank(durations, 0.95),
        earlyAbandonRate: rate(earlyAbandonCount, sessions.length),
        retentionAtSegmentEnd: rate(retainedAtSegmentEnd, sessions.length),
      };
    })
    .filter((breakdown): breakdown is TierRetentionBreakdown => breakdown !== null);
}

function selectFailureReason(
  manifest: BrowserRetentionMeasurementManifest,
  earlyAbandonRate: number,
  retentionCurve: BrowserRetentionMeasurementReport['retentionCurve'],
  retryResumeImpactMs: number,
): string | undefined {
  if (earlyAbandonRate > manifest.maxEarlyAbandonRate) {
    return `early-abandon-rate-exceeded: ${earlyAbandonRate} exceeds ${manifest.maxEarlyAbandonRate}`;
  }

  const segmentEndRetention = retentionCurve.find(
    (point) => point.windowMs === manifest.segmentDurationMs,
  ) ?? {
    retentionRate: rate(
      manifest.sessions.filter(
        (session) => session.sessionDurationMs >= manifest.segmentDurationMs,
      ).length,
      manifest.sessions.length,
    ),
  };
  if (segmentEndRetention.retentionRate < manifest.minRetentionAtSegmentEnd) {
    return `segment-retention-below-threshold: ${segmentEndRetention.retentionRate} below ${manifest.minRetentionAtSegmentEnd}`;
  }

  if (retryResumeImpactMs > manifest.maxRetryResumeImpactMs) {
    return `retry-resume-impact-exceeded: ${retryResumeImpactMs}ms exceeds ${manifest.maxRetryResumeImpactMs}ms`;
  }

  return undefined;
}

function tierSession(
  workerId: string,
  tier: WorkerTier,
  sessionDurationMs: number,
  heartbeatJitterMs: number,
  disconnectedDuringSegment?: number,
): BrowserWorkerSessionSample {
  return {
    workerId,
    tier,
    sessionDurationMs,
    heartbeatJitterMs,
    disconnectedDuringSegment,
  };
}

function percentileNearestRank(sortedValues: readonly number[], percentile: number): number {
  const rank = Math.ceil(percentile * sortedValues.length);
  return sortedValues[Math.max(0, rank - 1)];
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function sortNumber(a: number, b: number): number {
  return a - b;
}
