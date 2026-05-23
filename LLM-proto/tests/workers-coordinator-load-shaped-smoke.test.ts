import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import {
  runWorkersCoordinatorLoadShapedSmoke,
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

  return dispatcher.run('load-shaped-workers-assignment').assignments;
}

function createManifestFixture(index: number): WorkersCoordinatorPrototypeManifest {
  const segments = makeSegments(3);
  const assignments = createAssignmentFixture();
  return {
    ...createDefaultWorkersCoordinatorManifest(assignments, segments),
    requestId: `load-shaped-workers-coordinator-smoke-${index}`,
    receivedAtMs: 1_779_321_600_000 + index * 1_000,
  };
}

async function withPersistRoot<T>(run: (persistRoot: string) => Promise<T>): Promise<T> {
  const persistRoot = await mkdtemp(join(tmpdir(), 'unzen-workers-load-smoke-'));
  try {
    return await run(persistRoot);
  } finally {
    await rm(persistRoot, { recursive: true, force: true });
  }
}

describe('Workers Coordinator load-shaped runtime smoke', () => {
  it('drives concurrent request traffic, real client heartbeat timing, and Durable Object restart persistence', async () => {
    await withPersistRoot(async (persistRoot) => {
      const manifests = [0, 1, 2].map(createManifestFixture);
      const report = await runWorkersCoordinatorLoadShapedSmoke({
        manifests,
        durableObjectsPersistRoot: persistRoot,
        heartbeatBursts: 4,
        maxP95FanoutLatencyMs: 10_000,
      });

      expect(report.runtime).toBe('miniflare-load-shaped');
      expect(report.status).toBe('pass');
      expect(report.customerTraffic).toMatchObject({
        concurrentApiRequests: 3,
        acceptedApiRequests: 3,
        heartbeatBursts: 4,
        attemptedHeartbeatCount: 36,
        acceptedHeartbeatCount: 30,
        churnedHeartbeatCount: 6,
        churnedWorkerIds: [manifests[0].lostWorkerId],
      });
      expect(report.clientTiming.source).toBe('client-performance-now');
      expect(report.clientTiming.fanoutLatencySamplesMs).toHaveLength(30);
      expect(report.clientTiming.p95FanoutLatencyMs).toBeGreaterThanOrEqual(0);
      expect(report.restartPersistence).toMatchObject({
        persisted: true,
        durableObjectsPersistRoot: persistRoot,
        persistedRequestIds: manifests.map((manifest) => manifest.requestId),
        missingRequestIds: [],
      });
      expect(report.restartPersistence.afterRestartStorageKeyCount).toBeGreaterThanOrEqual(
        report.restartPersistence.beforeRestartStorageKeyCount,
      );
      expect(report.requestReports).toHaveLength(3);
      for (const requestReport of report.requestReports) {
        expect(requestReport.status).toBe('pass');
        expect(requestReport.durableObjectStorageFields.storageKeys).toEqual(
          expect.arrayContaining([
            `manifest:${requestReport.requestId}`,
            `request:${requestReport.requestId}:assignments`,
            `request:${requestReport.requestId}:lifecycle`,
            'direct-worker-networking',
          ]),
        );
        expect(requestReport.webSocketHeartbeatPath.processedHeartbeatCount).toBeGreaterThan(0);
      }
      expect(report.directWorkerNetworking).toEqual({
        attemptedEndpoint: 'https://worker-peer.example/direct',
        rejected: true,
        reason: 'worker-to-worker networking is outside the Coordinator/CDN allowlist',
        httpStatus: 403,
      });
      expect(report.retryResumeImpact).toMatchObject({
        totalRetryCount: 3,
        totalResumeCount: 3,
        maxEstimatedDelayMs: 470,
      });
      expect(report.failureReason).toBeUndefined();
    });
  });

  it('reports a failure reason when measured client heartbeat p95 is over budget', async () => {
    await withPersistRoot(async (persistRoot) => {
      const report = await runWorkersCoordinatorLoadShapedSmoke({
        manifests: [createManifestFixture(0)],
        durableObjectsPersistRoot: persistRoot,
        heartbeatBursts: 2,
        maxP95FanoutLatencyMs: -1,
      });

      expect(report.status).toBe('fail');
      expect(report.failureReason).toMatch(/^client-timing-p95-exceeded:/);
      expect(report.clientTiming.p95FanoutLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
