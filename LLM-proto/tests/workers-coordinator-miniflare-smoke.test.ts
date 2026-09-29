import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import {
  runWorkersCoordinatorMiniflareSmoke,
} from '../src/workers-coordinator-miniflare-smoke.js';
import {
  createDefaultWorkersCoordinatorManifest,
  type WorkersCoordinatorPrototypeManifest,
} from '../src/workers-coordinator-prototype.js';
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

  return dispatcher.run('miniflare-workers-assignment').assignments;
}

function createManifestFixture(
  overrides: Partial<WorkersCoordinatorPrototypeManifest> = {},
): WorkersCoordinatorPrototypeManifest {
  const segments = makeSegments(3);
  const assignments = createAssignmentFixture();
  return {
    ...createDefaultWorkersCoordinatorManifest(assignments, segments),
    requestId: 'miniflare-workers-coordinator-smoke',
    ...overrides,
  };
}

describe('Workers Coordinator Miniflare runtime smoke', () => {
  it('rejects an unbounded dispatcher transfer before JSON serialization', async () => {
    const segments = makeSegments(2);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments,
      configuredVramLimitMB: 2_100,
    });
    const zeroCheckpointThroughputTelemetry: WorkerTelemetry = {
      ...baseTelemetry,
      vramFreeMB: 2_100,
      checkpointBytesPerSecond: 0,
    };
    dispatcher.registerWorker({
      id: 'visitor-a',
      tier: WorkerTier.TIER_3,
      telemetry: zeroCheckpointThroughputTelemetry,
    });
    dispatcher.registerWorker({
      id: 'visitor-b',
      tier: WorkerTier.TIER_3,
      telemetry: zeroCheckpointThroughputTelemetry,
    });
    const assignments = dispatcher.run('miniflare-unbounded-transfer').assignments;
    expect(assignments[1].checkpointTransferMs).toBe(Number.POSITIVE_INFINITY);
    const manifest = {
      ...createDefaultWorkersCoordinatorManifest(assignments, segments),
      requestId: 'miniflare-unbounded-transfer',
    };

    await expect(runWorkersCoordinatorMiniflareSmoke({ manifest })).rejects.toThrow(
      'assignment 1 checkpointTransferMs must be a non-negative safe integer before Miniflare JSON serialization',
    );
  });

  it('rejects retry/resume timing overflow before starting Miniflare', async () => {
    const manifest = createManifestFixture({
      checkpointRelayMs: Number.MAX_SAFE_INTEGER,
      retryBackoffMs: 1,
    });

    await expect(runWorkersCoordinatorMiniflareSmoke({ manifest })).rejects.toThrow(
      'retry/resume estimatedDelayMs exceeds JavaScript safe integer range before Miniflare JSON serialization',
    );
  });

  it('rejects synthetic heartbeat schedule overflow before starting Miniflare', async () => {
    const manifest = createManifestFixture({
      receivedAtMs: Number.MAX_SAFE_INTEGER,
    });

    await expect(runWorkersCoordinatorMiniflareSmoke({ manifest })).rejects.toThrow(
      'heartbeat sentAtMs exceeds JavaScript safe integer range before Miniflare JSON serialization',
    );
  });

  it('uses one owned manifest snapshot across asynchronous Miniflare work', async () => {
    const base = createManifestFixture();
    let requestIdReads = 0;
    const manifest = {
      ...base,
      get requestId() {
        requestIdReads++;
        return requestIdReads === 1
          ? 'miniflare-owned-snapshot'
          : 'miniflare-caller-mutated';
      },
    } as WorkersCoordinatorPrototypeManifest;

    const report = await runWorkersCoordinatorMiniflareSmoke({
      manifest,
      concurrentHeartbeatBursts: 1,
    });

    expect(requestIdReads).toBe(1);
    expect(report.requestId).toBe('miniflare-owned-snapshot');
    expect(report.durableObjectStorageFields.storageKeys).toEqual(
      expect.arrayContaining([
        'manifest:miniflare-owned-snapshot',
        'request:miniflare-owned-snapshot:lifecycle',
        'request:miniflare-owned-snapshot:assignments',
      ]),
    );
  });

  it('runs API lifecycle, Durable Object storage, WebSocket heartbeat, assignment, checkpoint, and rejection paths in Miniflare', async () => {
    const manifest = createManifestFixture();
    const report = await runWorkersCoordinatorMiniflareSmoke({ manifest });

    expect(report.runtime).toBe('miniflare');
    expect(report.status).toBe('pass');
    expect(report.requestLifecycle).toMatchObject({
      endpoint: '/api/requests',
      httpStatus: 202,
      plannedSegmentCount: 3,
      promptTokens: 64,
    });
    expect(report.durableObjectStorageFields).toMatchObject({
      owner: 'durable-object',
      singleWriter: true,
    });
    expect(report.durableObjectStorageFields.eligibleWorkers).toEqual([
      'stable-t2-a',
      'stable-t2-b',
      'visitor-t3-a',
    ]);
    expect(report.durableObjectStorageFields.storageKeys).toEqual(
      expect.arrayContaining([
        'manifest:miniflare-workers-coordinator-smoke',
        'request:miniflare-workers-coordinator-smoke:lifecycle',
        'request:miniflare-workers-coordinator-smoke:assignments',
        'worker:stable-t2-a:registration',
        'worker:stable-t2-a:heartbeat:miniflare-workers-coordinator-smoke:0',
        'worker:stable-t2-b:heartbeat:miniflare-workers-coordinator-smoke:0',
        'worker:visitor-t3-a:heartbeat:miniflare-workers-coordinator-smoke:0',
        'direct-worker-networking',
      ]),
    );
    expect(report.assignmentReport).toEqual({
      source: 'AdaptiveChunkDispatcher',
      importedByRuntime: true,
      assignments: manifest.assignments,
    });
    expect(report.checkpointRelay).toMatchObject({
      owner: 'coordinator-storage',
      directWorkerNetworking: false,
      bytes: 4 * 1024 * 1024,
      relayMs: 420,
    });
    expect(report.durableObjectStorageFields.checkpointMetadata).toEqual(
      report.checkpointRelay.storageKeys.map((key) => expect.objectContaining({ key })),
    );
    expect(report.retryResumeImpact).toEqual({
      lostWorkerId: manifest.assignments[0].workerId,
      retryCount: 1,
      resumeCount: 1,
      estimatedDelayMs: 470,
      resumedFromSegment: manifest.assignments[0].startSegment,
    });
    expect(report.webSocketHeartbeatPath).toMatchObject({
      upgradeEndpoint: '/workers/:workerId/socket',
      acceptedStatus: 101,
      processedHeartbeatCount: 12,
      concurrentHeartbeatBursts: 4,
      p95FanoutLatencyMs: 193,
    });
    expect(report.directWorkerNetworking).toEqual({
      attemptedEndpoint: 'https://worker-peer.example/direct',
      rejected: true,
      reason: 'worker-to-worker networking is outside the Coordinator/CDN allowlist',
      httpStatus: 403,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toContain(
      'wrangler-preview-retry-resume-load-shed-policy',
    );
  });

  it('fails when Miniflare WebSocket heartbeat fan-out p95 exceeds the real runtime gate', async () => {
    const report = await runWorkersCoordinatorMiniflareSmoke({
      manifest: createManifestFixture({
        maxFanoutLatencyMs: 120,
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.webSocketHeartbeatPath.p95FanoutLatencyMs).toBe(193);
    expect(report.failureReason).toBe('fanout-latency-exceeded: 193ms exceeds 120ms');
    expect(report.bottlenecksToIssue).toContain(
      'miniflare-durable-object-websocket-fanout-p95',
    );
  });
});
