import { describe, expect, it } from 'vitest';
import {
  buildCoordinatorPrototypeSegments,
  createDefaultCoordinatorPrototypeManifest,
  runCoordinatorPrototype,
} from '../src/coordinator-prototype.js';
import {
  createDefaultBrowserRetentionManifest,
  measureBrowserWorkerRetention,
  type BrowserRetentionMeasurementReport,
} from '../src/browser-worker-retention.js';
import { WorkerTier } from '../src/types.js';

describe('Coordinator prototype harness', () => {
  it('accepts an API request, registers heartbeats, assigns chunks, relays checkpoints, and reports resume impact', () => {
    const report = runCoordinatorPrototype(createDefaultCoordinatorPrototypeManifest());

    expect(report.status).toBe('pass');
    expect(report.requestLifecycle).toMatchObject({
      accepted: true,
      completed: true,
      finalSegment: 5,
    });
    expect(report.workerHeartbeats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workerId: 'tier1-signage-a',
          tier: WorkerTier.TIER_1,
          eligible: true,
        }),
      ]),
    );
    expect(report.assignments.length).toBeGreaterThan(1);
    expect(report.assignments[0]).toEqual(
      expect.objectContaining({
        assignedBy: 'AdaptiveChunkDispatcher',
        scoreInputs: expect.objectContaining({
          total: expect.any(Number),
        }),
      }),
    );
    expect(report.checkpointRelay.length).toBeGreaterThan(0);
    expect(report.checkpointRelay.every((relay) =>
      relay.via === 'coordinator' && relay.directWorkerNetworking === false
    )).toBe(true);
    expect(report.transport.connections.every((connection) =>
      connection.startsWith('https://coordinator.unzen.local') ||
      connection.startsWith('https://cdn.unzen.local')
    )).toBe(true);
    expect(report.retryResumeImpact).toEqual(
      expect.objectContaining({
        retryCount: 1,
        resumeCount: 1,
        affectedSegments: expect.arrayContaining([expect.any(Number)]),
        failureReason: expect.stringContaining('worker-lost:'),
      }),
    );
    expect(report.bottlenecksToIssue).toContain(
      'cloudflare-workers-websocket-durable-state-validation',
    );
  });

  it('applies the browser retention gate to Tier 3 assignment eligibility', () => {
    const failingRetention = createTier3ChurnReport();
    const report = runCoordinatorPrototype({
      ...createDefaultCoordinatorPrototypeManifest(),
      requestId: 'tier3-churn-coordinator-prototype',
      retentionReport: failingRetention,
      tier3MinRetentionAtSegmentEnd: 0.9,
    });

    const tier3Heartbeat = report.workerHeartbeats.find(
      (heartbeat) => heartbeat.tier === WorkerTier.TIER_3,
    );
    expect(tier3Heartbeat).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: expect.stringContaining('tier3-retention-below-assignment-threshold'),
      }),
    );
    expect(report.assignments.some((assignment) => assignment.tier === WorkerTier.TIER_3))
      .toBe(false);
  });

  it('fails closed when no eligible worker can cover the request lifecycle', () => {
    const report = runCoordinatorPrototype({
      requestId: 'no-eligible-workers',
      prompt: 'test',
      segments: buildCoordinatorPrototypeSegments(2),
      workers: [],
    });

    expect(report.status).toBe('fail');
    expect(report.requestLifecycle.completed).toBe(false);
    expect(report.failureReason).toContain('No eligible adaptive worker');
  });
});

function createTier3ChurnReport(): BrowserRetentionMeasurementReport {
  return measureBrowserWorkerRetention({
    ...createDefaultBrowserRetentionManifest(),
    requestId: 'tier3-churn',
    sessions: [
      {
        workerId: 'tier3-short-a',
        tier: WorkerTier.TIER_3,
        sessionDurationMs: 1_000,
        heartbeatJitterMs: 2_000,
        disconnectedDuringSegment: 0,
      },
      {
        workerId: 'tier3-short-b',
        tier: WorkerTier.TIER_3,
        sessionDurationMs: 2_000,
        heartbeatJitterMs: 2_100,
        disconnectedDuringSegment: 0,
      },
      {
        workerId: 'tier3-long-a',
        tier: WorkerTier.TIER_3,
        sessionDurationMs: 90_000,
        heartbeatJitterMs: 200,
      },
    ],
  });
}
