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
  it('fails closed on malformed controls before deployed network activity', async () => {
    const cases = [
      {
        overrides: { heartbeatBursts: Number.POSITIVE_INFINITY },
        message: 'heartbeatBursts must be a non-negative safe integer before deployed smoke network activity',
      },
      {
        overrides: { heartbeatBursts: 1.5 },
        message: 'heartbeatBursts must be a non-negative safe integer before deployed smoke network activity',
      },
      {
        overrides: { maxBrowserP95FanoutLatencyMs: Number.NaN },
        message: 'maxBrowserP95FanoutLatencyMs must be a non-negative finite number before deployed smoke network activity',
      },
      {
        overrides: { maxEdgePlacementVarianceMs: Number.POSITIVE_INFINITY },
        message: 'maxEdgePlacementVarianceMs must be a non-negative finite number before deployed smoke network activity',
      },
    ];

    for (const { overrides, message } of cases) {
      let postRequestCalls = 0;
      const passingClient = createPassingClient();
      const client: WorkersCoordinatorDeployedSmokeClient = {
        ...passingClient,
        async postRequest(target, manifest) {
          postRequestCalls++;
          return passingClient.postRequest(target, manifest);
        },
      };

      await expect(runWorkersCoordinatorDeployedSmoke({
        manifest: createManifestFixture(),
        target: createTarget(),
        client,
        ...overrides,
      })).rejects.toThrow(message);
      expect(postRequestCalls).toBe(0);
    }
  });

  it('rejects heartbeat count multiplication overflow before deployed network activity', async () => {
    let postRequestCalls = 0;
    const passingClient = createPassingClient();
    const client: WorkersCoordinatorDeployedSmokeClient = {
      ...passingClient,
      async postRequest(target, manifest) {
        postRequestCalls++;
        return passingClient.postRequest(target, manifest);
      },
    };

    await expect(runWorkersCoordinatorDeployedSmoke({
      manifest: createManifestFixture(),
      target: createTarget(),
      client,
      heartbeatBursts: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(
      'expectedHeartbeatCount exceeds JavaScript safe integer range before deployed smoke network activity',
    );
    expect(postRequestCalls).toBe(0);
  });

  it('keeps one owned manifest and deployment target across async client calls', async () => {
    const baseManifest = createManifestFixture();
    const baseTarget = createTarget();
    let requestIdReads = 0;
    let workersReads = 0;
    let baseUrlReads = 0;
    const manifest = {
      ...baseManifest,
      get requestId() {
        requestIdReads++;
        return requestIdReads === 1 ? 'deployed-owned-snapshot' : 'caller-mutated-request';
      },
      get workers() {
        workersReads++;
        return workersReads === 1 ? baseManifest.workers : [];
      },
    } as WorkersCoordinatorPrototypeManifest;
    const target = {
      ...baseTarget,
      get baseUrl() {
        baseUrlReads++;
        return baseUrlReads === 1 ? baseTarget.baseUrl : 'https://mutated.example';
      },
    } as WorkersCoordinatorDeploymentTarget;
    const seenTargets: string[] = [];
    const seenRequestIds: string[] = [];
    const passingClient = createPassingClient();
    const client: WorkersCoordinatorDeployedSmokeClient = {
      ...passingClient,
      async postRequest(seenTarget, seenManifest) {
        seenTargets.push(seenTarget.baseUrl);
        seenRequestIds.push(seenManifest.requestId);
        return passingClient.postRequest(seenTarget, seenManifest);
      },
      async sendHeartbeat(seenTarget, workerId, payload) {
        seenTargets.push(seenTarget.baseUrl);
        seenRequestIds.push(payload.requestId);
        return passingClient.sendHeartbeat(seenTarget, workerId, payload);
      },
      async readReport(seenTarget, requestId) {
        seenTargets.push(seenTarget.baseUrl);
        seenRequestIds.push(requestId);
        return passingClient.readReport(seenTarget, requestId);
      },
    };

    const report = await runWorkersCoordinatorDeployedSmoke({
      manifest,
      target,
      client,
      heartbeatBursts: 1,
      maxEdgePlacementVarianceMs: 30,
    });

    expect(requestIdReads).toBe(1);
    expect(workersReads).toBe(1);
    expect(baseUrlReads).toBe(1);
    expect(report.requestId).toBe('deployed-owned-snapshot');
    expect(report.target.baseUrl).toBe(baseTarget.baseUrl);
    expect(report.browserWebSocketTiming.attemptedHeartbeatCount).toBe(baseManifest.workers.length);
    expect(seenTargets.every((value) => value === baseTarget.baseUrl)).toBe(true);
    expect(seenRequestIds.every((value) => value === 'deployed-owned-snapshot')).toBe(true);
  });

  it('rejects malformed request latency before heartbeat activity', async () => {
    let sendHeartbeatCalls = 0;
    const passingClient = createPassingClient();
    const client: WorkersCoordinatorDeployedSmokeClient = {
      ...passingClient,
      async postRequest() {
        return { httpStatus: 202, edgeColo: 'NRT', latencyMs: Number.NaN };
      },
      async sendHeartbeat(target, workerId, payload) {
        sendHeartbeatCalls++;
        return passingClient.sendHeartbeat(target, workerId, payload);
      },
    };

    await expect(runWorkersCoordinatorDeployedSmoke({
      manifest: createManifestFixture(),
      target: createTarget(),
      client,
      heartbeatBursts: 1,
    })).rejects.toThrow(
      'deployed request latencyMs must be a non-negative finite number before deployed smoke heartbeat activity',
    );
    expect(sendHeartbeatCalls).toBe(0);
  });

  it('rejects heartbeat acknowledgement identity mismatches before report lookup', async () => {
    let readReportCalls = 0;
    const passingClient = createPassingClient();
    const client: WorkersCoordinatorDeployedSmokeClient = {
      ...passingClient,
      async sendHeartbeat(target, workerId, payload) {
        const ack = await passingClient.sendHeartbeat(target, workerId, payload);
        return { ...ack, requestId: 'wrong-request' };
      },
      async readReport(target, requestId) {
        readReportCalls++;
        return passingClient.readReport(target, requestId);
      },
    };

    await expect(runWorkersCoordinatorDeployedSmoke({
      manifest: createManifestFixture(),
      target: createTarget(),
      client,
      heartbeatBursts: 1,
    })).rejects.toThrow(
      'heartbeat acknowledgement requestId mismatch: expected deployed-workers-coordinator-smoke, got wrong-request',
    );
    expect(readReportCalls).toBe(0);
  });

  it('rejects non-finite heartbeat latency before report evaluation', async () => {
    let rejectDirectWorkerNetworkingCalls = 0;
    const passingClient = createPassingClient();
    const client: WorkersCoordinatorDeployedSmokeClient = {
      ...passingClient,
      async sendHeartbeat(target, workerId, payload) {
        const ack = await passingClient.sendHeartbeat(target, workerId, payload);
        return { ...ack, clientMeasuredLatencyMs: Number.NaN };
      },
      async rejectDirectWorkerNetworking(target) {
        rejectDirectWorkerNetworkingCalls++;
        return passingClient.rejectDirectWorkerNetworking(target);
      },
    };

    await expect(runWorkersCoordinatorDeployedSmoke({
      manifest: createManifestFixture(),
      target: createTarget(),
      client,
      heartbeatBursts: 1,
    })).rejects.toThrow(
      'heartbeat deployed-t2-a clientMeasuredLatencyMs must be a non-negative finite number before deployed smoke report evaluation',
    );
    expect(rejectDirectWorkerNetworkingCalls).toBe(0);
  });

  it('rejects an upstream report for a different request identity', async () => {
    const passingClient = createPassingClient();
    const client: WorkersCoordinatorDeployedSmokeClient = {
      ...passingClient,
      async readReport(target, requestId) {
        const report = await passingClient.readReport(target, requestId);
        return { ...report, requestId: 'wrong-request' };
      },
    };

    await expect(runWorkersCoordinatorDeployedSmoke({
      manifest: createManifestFixture(),
      target: createTarget(),
      client,
      heartbeatBursts: 1,
    })).rejects.toThrow(
      'upstream report requestId mismatch: expected deployed-workers-coordinator-smoke, got wrong-request',
    );
  });

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
