import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import {
  createDefaultWorkersCoordinatorManifest,
  runWorkersCoordinatorPrototype,
  type WorkersCoordinatorPrototypeManifest,
} from '../src/workers-coordinator-prototype.js';
import { AllowlistedPrototypeTransport } from '../src/two-worker-prototype.js';
import { WorkerTier } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

const baseTelemetry: WorkerTelemetry = {
  uptimeMs: 2 * 60 * 60 * 1000,
  vramFreeMB: 4200,
  gpuBusyRatio: 0.01,
  cpuBusyRatio: 0.01,
  cacheHits: [],
  tokensPerSecond: 18,
  checkpointBytesPerSecond: 10 * 1024 * 1024,
  failureRate: 0,
  heartbeatJitterMs: 25,
};

function createAssignmentFixture() {
  const dispatcher = new AdaptiveChunkDispatcher({
    segments: makeSegments(3),
    configuredVramLimitMB: 4200,
  });
  dispatcher.registerWorker({
    id: 'stable-t2-a',
    tier: WorkerTier.TIER_2,
    telemetry: baseTelemetry,
  });
  dispatcher.registerWorker({
    id: 'stable-t2-b',
    tier: WorkerTier.TIER_2,
    telemetry: {
      ...baseTelemetry,
      tokensPerSecond: 12,
    },
  });

  return dispatcher.run('workers-assignment').assignments;
}

describe('Workers Coordinator prototype gate', () => {
  it('reports API lifecycle, Durable Object worker state, assignments, checkpoint relay, and retry impact', () => {
    const segments = makeSegments(3);
    const assignments = createAssignmentFixture();
    const report = runWorkersCoordinatorPrototype(
      createDefaultWorkersCoordinatorManifest(assignments, segments),
    );

    expect(report.status).toBe('pass');
    expect(report.requestLifecycle).toMatchObject({
      endpoint: '/api/requests',
      plannedSegmentCount: 3,
      promptTokens: 64,
    });
    expect(report.workerStateBoundary).toMatchObject({
      owner: 'durable-object',
      singleWriter: true,
    });
    expect(report.workerStateBoundary.eligibleWorkers).toEqual([
      'stable-t2-a',
      'stable-t2-b',
      'visitor-t3-a',
    ]);
    expect(report.assignmentReport).toEqual({
      source: 'AdaptiveChunkDispatcher',
      assignments,
    });
    expect(report.checkpointRelay).toMatchObject({
      owner: 'coordinator-storage',
      directWorkerNetworking: false,
      bytes: 4 * 1024 * 1024,
      relayMs: 420,
    });
    expect(report.retryResumeImpact).toEqual({
      lostWorkerId: assignments[0].workerId,
      retryCount: 1,
      resumeCount: 1,
      estimatedDelayMs: 470,
      resumedFromSegment: assignments[0].startSegment,
    });
    expect(report.webSocketHeartbeatPath).toEqual({
      upgradeEndpoint: '/workers/:workerId/socket',
      processedHeartbeatCount: 3,
      fanoutLatencySamplesMs: [100, 127, 154],
      p95FanoutLatencyMs: 154,
    });
    expect(report.directWorkerNetworking).toEqual({
      attemptedEndpoint: 'https://worker-peer.example/direct',
      rejected: true,
      reason: 'worker-to-worker networking is outside the Coordinator/CDN allowlist',
    });
    expect(report.bottlenecksToIssue).toContain(
      'wrangler-preview-retry-resume-load-shed-policy',
    );
    expect(report.failureReason).toBeUndefined();
  });

  it('keeps the Workers prototype inside Coordinator/CDN transport boundaries', () => {
    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    const report = runWorkersCoordinatorPrototype(
      createDefaultWorkersCoordinatorManifest(createAssignmentFixture(), makeSegments(3)),
      transport,
    );

    expect(new Set(report.transport.connections)).toEqual(new Set([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]));
    expect(() => transport.connect('https://worker-peer.example/direct')).toThrow(
      /outside prototype allowlist/,
    );
  });

  it('fails when no worker is eligible in the single-writer state boundary', () => {
    const base = createDefaultWorkersCoordinatorManifest(createAssignmentFixture(), makeSegments(3));
    const manifest: WorkersCoordinatorPrototypeManifest = {
      ...base,
      workers: base.workers.map((worker) => ({
        ...worker,
        eligible: false,
      })),
    };

    const report = runWorkersCoordinatorPrototype(manifest);

    expect(report.status).toBe('fail');
    expect(report.workerStateBoundary.eligibleWorkers).toEqual([]);
    expect(report.failureReason).toBe('no-eligible-workers');
  });

  it('fails when an assignment bypasses Durable Object eligibility', () => {
    const base = createDefaultWorkersCoordinatorManifest(createAssignmentFixture(), makeSegments(3));
    const manifest: WorkersCoordinatorPrototypeManifest = {
      ...base,
      workers: base.workers.map((worker) => worker.id === base.assignments[0].workerId
        ? {
          ...worker,
          eligible: false,
        }
        : worker),
    };

    const report = runWorkersCoordinatorPrototype(manifest);

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      `assignment-worker-ineligible: ${base.assignments[0].workerId}`,
    );
  });

  it('fails when retry resume impact exceeds the Workers scale-up gate', () => {
    const base = createDefaultWorkersCoordinatorManifest(createAssignmentFixture(), makeSegments(3));
    const manifest: WorkersCoordinatorPrototypeManifest = {
      ...base,
      checkpointRelayMs: 980,
      retryBackoffMs: 75,
      maxRetryResumeImpactMs: 1_000,
    };

    const report = runWorkersCoordinatorPrototype(manifest);

    expect(report.status).toBe('fail');
    expect(report.retryResumeImpact).toMatchObject({
      retryCount: 1,
      resumeCount: 1,
      estimatedDelayMs: 1_055,
    });
    expect(report.failureReason).toBe('retry-resume-impact-exceeded: 1055ms exceeds 1000ms');
  });
});


it('fails on p95 WebSocket heartbeat fan-out latency over budget', () => {
  const base = createDefaultWorkersCoordinatorManifest(createAssignmentFixture(), makeSegments(3));
  const report = runWorkersCoordinatorPrototype({
    ...base,
    maxFanoutLatencyMs: 120,
  });

  expect(report.status).toBe('fail');
  expect(report.webSocketHeartbeatPath.p95FanoutLatencyMs).toBe(154);
  expect(report.failureReason).toBe('fanout-latency-exceeded: 154ms exceeds 120ms');
  expect(report.bottlenecksToIssue).toContain(
    'miniflare-durable-object-websocket-fanout-p95',
  );
});
