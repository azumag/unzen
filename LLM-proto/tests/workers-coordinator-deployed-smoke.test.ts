import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorDeployedSmokeClient,
  WorkersCoordinatorDeploymentTarget,
} from '../src/workers-coordinator-deployed-smoke.js';
import {
  runWorkersCoordinatorDeployedSmoke,
} from '../src/workers-coordinator-deployed-smoke.js';
import {
  createDefaultWorkersCoordinatorManifest,
  type WorkersCoordinatorPrototypeManifest,
} from '../src/workers-coordinator-prototype.js';
import { WorkerTier } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

function createManifestFixture(): WorkersCoordinatorPrototypeManifest {
  return {
    ...createDefaultWorkersCoordinatorManifest([
      {
        workerId: 'deployed-t2-a',
        tier: WorkerTier.TIER_2,
        startSegment: 0,
        endSegment: 1,
        selectedChunkLength: 2,
        score: 0.92,
        estimatedComputeMs: 240,
        checkpointTransferMs: 45,
        checkpointTransferBytes: 256_000,
        cacheHit: true,
        retryCount: 0,
      },
      {
        workerId: 'deployed-t2-b',
        tier: WorkerTier.TIER_2,
        startSegment: 2,
        endSegment: 2,
        selectedChunkLength: 1,
        score: 0.77,
        estimatedComputeMs: 180,
        checkpointTransferMs: 30,
        checkpointTransferBytes: 128_000,
        cacheHit: false,
        retryCount: 0,
      },
    ], makeSegments(3)),
    requestId: 'deployed-workers-coordinator-smoke',
    maxFanoutLatencyMs: 100,
  };
}

function createTarget(): WorkersCoordinatorDeploymentTarget {
  return {
    baseUrl: 'https://preview.unzen-workers.example',
    runtime: 'wrangler-preview',
    environment: 'preview',
    authHeaderName: 'Authorization',
    authToken: 'test-token',
    durableObjectMigrationTag: 'workers-coordinator-v1',
    edgePlacementHints: ['NRT', 'SJC'],
  };
}

function createPassingClient(): WorkersCoordinatorDeployedSmokeClient {
  return {
    async postRequest() {
      return {
        httpStatus: 202,
        edgeColo: 'NRT',
        latencyMs: 18,
      };
    },
    async sendHeartbeat(_target, workerId, payload) {
      return {
        ok: true,
        workerId,
        requestId: payload.requestId,
        burst: payload.burst,
        clientMeasuredLatencyMs: workerId.endsWith('a') ? 21 : 33,
        edgeColo: workerId.endsWith('a') ? 'NRT' : 'SJC',
      };
    },
    async rejectDirectWorkerNetworking() {
      return {
        attemptedEndpoint: 'https://worker-peer.example/direct',
        rejected: true,
        reason: 'worker-to-worker networking is outside the Coordinator/CDN allowlist',
        httpStatus: 403,
      };
    },
    async readReport(_target, requestId) {
      return {
        runtime: 'miniflare',
        requestId,
        status: 'pass',
        requestLifecycle: {
          endpoint: '/api/requests',
          acceptedAtMs: 1_779_321_600_000,
          plannedSegmentCount: 3,
          promptTokens: 128,
          completedAtMs: 1_779_321_600_050,
          httpStatus: 202,
        },
        durableObjectStorageFields: {
          owner: 'durable-object',
          singleWriter: true,
          storageKeys: [
            `manifest:${requestId}`,
            `request:${requestId}:assignments`,
            `request:${requestId}:lifecycle`,
          ],
          registeredWorkers: [
            {
              workerId: 'deployed-t2-a',
              tier: WorkerTier.TIER_2,
              heartbeatAtMs: 1_779_321_600_000,
              eligible: true,
              maxChunkLength: 2,
            },
          ],
          eligibleWorkers: ['deployed-t2-a'],
          checkpointMetadata: [],
        },
        assignmentReport: {
          source: 'AdaptiveChunkDispatcher',
          importedByRuntime: true,
          assignments: [],
        },
        checkpointRelay: {
          owner: 'coordinator-storage',
          directWorkerNetworking: false,
          bytes: 256_000,
          relayMs: 45,
          storageKeys: [],
        },
        retryResumeImpact: {
          retryCount: 0,
          resumeCount: 0,
          estimatedDelayMs: 0,
          resumedFromSegment: null,
        },
        webSocketHeartbeatPath: {
          upgradeEndpoint: '/workers/:workerId/socket',
          acceptedStatus: 101,
          processedHeartbeatCount: 8,
          fanoutLatencySamplesMs: [21, 33],
          p95FanoutLatencyMs: 33,
          concurrentHeartbeatBursts: 4,
        },
        directWorkerNetworking: {
          attemptedEndpoint: 'https://worker-peer.example/direct',
          rejected: true,
          reason: 'worker-to-worker networking is outside the Coordinator/CDN allowlist',
          httpStatus: 403,
        },
        fanoutLatencyMs: 33,
        bottlenecksToIssue: ['production-observability-and-canary-release'],
      };
    },
  };
}

describe('Workers Coordinator deployed runtime smoke', () => {
  it('reports authenticated preview metadata, browser WebSocket timing, and edge placement variance', async () => {
    const report = await runWorkersCoordinatorDeployedSmoke({
      manifest: createManifestFixture(),
      target: createTarget(),
      client: createPassingClient(),
      heartbeatBursts: 4,
      maxEdgePlacementVarianceMs: 30,
    });

    expect(report.runtime).toBe('deployed-workers-smoke');
    expect(report.status).toBe('pass');
    expect(report.target).toMatchObject({
      runtime: 'wrangler-preview',
      environment: 'preview',
      authHeaderName: 'Authorization',
      authHeaderPresent: true,
      durableObjectMigrationTag: 'workers-coordinator-v1',
      edgePlacementHints: ['NRT', 'SJC'],
    });
    expect(report.requestLifecycle).toMatchObject({
      httpStatus: 202,
      edgeColo: 'NRT',
      deployedFetchLatencyMs: 18,
    });
    expect(report.browserWebSocketTiming).toMatchObject({
      source: 'real-browser-websocket-client',
      heartbeatBursts: 4,
      attemptedHeartbeatCount: 12,
      acceptedHeartbeatCount: 12,
      p95FanoutLatencyMs: 33,
    });
    expect(report.edgePlacement.varianceMs).toBe(15);
    expect(report.directWorkerNetworking.httpStatus).toBe(403);
    expect(report.bottlenecksToIssue).toEqual(['production-observability-and-canary-release']);
  });

  it('fails when browser WebSocket p95 is over the deployed budget', async () => {
    const report = await runWorkersCoordinatorDeployedSmoke({
      manifest: createManifestFixture(),
      target: createTarget(),
      client: createPassingClient(),
      heartbeatBursts: 1,
      maxBrowserP95FanoutLatencyMs: 10,
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('browser-websocket-p95-exceeded: 33ms exceeds 10ms');
    expect(report.bottlenecksToIssue).toEqual(['real-browser-websocket-fanout-p95']);
  });

  it('fails when deployed edge placement variance exceeds the preview budget', async () => {
    const report = await runWorkersCoordinatorDeployedSmoke({
      manifest: createManifestFixture(),
      target: createTarget(),
      client: createPassingClient(),
      heartbeatBursts: 1,
      maxEdgePlacementVarianceMs: 5,
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('edge-placement-variance-exceeded: 15ms exceeds 5ms');
    expect(report.bottlenecksToIssue).toEqual(['worker-edge-placement-variance-routing']);
  });
});
