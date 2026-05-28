import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorSignedRunnerBrowserPreviewReport,
} from '../src/workers-coordinator-signed-runner-browser-preview.js';
import {
  runWorkersCoordinatorSignedRunnerWebGpuWorkerPilot,
  type WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence,
} from '../src/workers-coordinator-signed-runner-webgpu-worker-pilot.js';

function createPreviewReport(
  overrides: Partial<WorkersCoordinatorSignedRunnerBrowserPreviewReport> = {},
): WorkersCoordinatorSignedRunnerBrowserPreviewReport {
  const base: WorkersCoordinatorSignedRunnerBrowserPreviewReport = {
    runtime: 'signed-runner-browser-preview-verification',
    status: 'pass',
    target: {
      baseUrl: 'https://preview.unzen-workers.example',
      runtime: 'wrangler-preview',
      environment: 'preview',
      authHeaderName: 'Authorization',
      authHeaderPresent: true,
    },
    browserHarness: {
      source: 'real-browser-harness',
      capturedAtMs: 1_779_667_200_000,
      runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
    },
    releaseGateReport: {
      runtime: 'signed-runner-csp-coop-coep-release-gate',
      status: 'pass',
      requestId: 'signed-runner-webgpu-pilot',
      runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
      csp: {
        connectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
        scriptSrc: ["'self'"],
        workerSrc: ["'self'"],
        allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      },
      sandboxIframe: {
        flags: ['allow-scripts'],
        allowScriptsOnly: true,
        topLevelDomAccessDenied: true,
        topLevelCookieAccessDenied: true,
        topLevelStorageAccessDenied: true,
      },
      coopCoepHeaders: {
        coop: 'same-origin',
        coep: 'require-corp',
        isolated: true,
      },
      signature: {
        keyId: 'unzen-runner-release-key-2026-05',
        runnerSha256: 'sha256:eb8fa4d2ae6f7f733b12b8237658ea9bb219a8e41ec8fe4e6e844a368c1d9e6c',
        verified: true,
      },
      networkBoundary: {
        allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
        attempts: [],
        blockedNonCoordinatorCdnNetworkAttempt: {
          url: 'https://analytics.example.test/beacon',
          initiator: 'iframe',
          blocked: true,
          reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
        },
      },
      bottlenecksToIssue: ['signed-runner-real-webgpu-worker-pilot'],
    },
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    blockedNonCoordinatorCdnNetworkAttempt: {
      url: 'https://analytics.example.test/beacon',
      initiator: 'iframe',
      blocked: true,
      reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
    },
    bottlenecksToIssue: ['signed-runner-real-webgpu-worker-pilot'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createPilotEvidence(
  overrides: Partial<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence> = {},
): WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence {
  return {
    source: 'real-browser-webgpu-worker-pilot',
    runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    capturedAtMs: 1_779_667_260_000,
    segmentExecution: {
      modelId: 'unzen-30b-q4-8seg-feasibility',
      segmentId: 'segment-03',
      runtime: 'webgpu-dedicated-worker',
      state: 'completed',
      layerStart: 24,
      layerEnd: 31,
      startedAtMs: 1_779_667_250_000,
      completedAtMs: 1_779_667_258_900,
      outputCheckpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
    },
    indexedDbCache: {
      backend: 'indexeddb',
      databaseName: 'unzen-model-cache',
      segmentWeightKey: 'models/unzen-30b-q4/segment-03.bin',
      cacheHit: true,
      topLevelStorageAccessed: false,
    },
    checkpointRelay: {
      owner: 'coordinator-storage',
      checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
      relayUrl: 'https://coordinator.unzen.dev/checkpoints/signed-runner-webgpu-pilot/segment-03',
      directWorkerNetworking: false,
      topLevelDomAccessed: false,
      topLevelCookieAccessed: false,
      topLevelStorageAccessed: false,
    },
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'wss://coordinator.unzen.dev/workers/webgpu-pilot/socket',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/models/unzen-30b-q4/segment-03.bin',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/segment-metrics',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    ],
    ...overrides,
  };
}

describe('Workers Coordinator signed runner real WebGPU worker pilot', () => {
  it('passes completed model segment execution while signed runner isolation remains active', () => {
    const report = runWorkersCoordinatorSignedRunnerWebGpuWorkerPilot({
      previewReport: createPreviewReport(),
      pilotEvidence: createPilotEvidence(),
    });

    expect(report.runtime).toBe('signed-runner-real-webgpu-worker-pilot');
    expect(report.status).toBe('pass');
    expect(report.previewRunnerUrl).toBe('https://preview.unzen-workers.example/runners/signed/runner.html');
    expect(report.segmentExecution).toMatchObject({
      runtime: 'webgpu-dedicated-worker',
      state: 'completed',
      outputCheckpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
    });
    expect(report.indexedDbCache).toMatchObject({
      backend: 'indexeddb',
      cacheHit: true,
      topLevelStorageAccessed: false,
    });
    expect(report.checkpointRelay).toMatchObject({
      owner: 'coordinator-storage',
      directWorkerNetworking: false,
      topLevelDomAccessed: false,
      topLevelCookieAccessed: false,
      topLevelStorageAccessed: false,
    });
    expect(report.securityBoundaryDuringExecution).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringExecution.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/segment-metrics',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['webgpu-worker-performance-and-fallback-telemetry']);
  });

  it('fails when model segment execution starts but does not complete', () => {
    const report = runWorkersCoordinatorSignedRunnerWebGpuWorkerPilot({
      previewReport: createPreviewReport(),
      pilotEvidence: createPilotEvidence({
        segmentExecution: {
          modelId: 'unzen-30b-q4-8seg-feasibility',
          segmentId: 'segment-03',
          runtime: 'webgpu-dedicated-worker',
          state: 'started',
          layerStart: 24,
          layerEnd: 31,
          startedAtMs: 1_779_667_250_000,
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('segment-execution-not-completed: started');
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-webgpu-segment-execution-hardening']);
  });

  it('fails when IndexedDB cache evidence depends on top-level page storage', () => {
    const report = runWorkersCoordinatorSignedRunnerWebGpuWorkerPilot({
      previewReport: createPreviewReport(),
      pilotEvidence: createPilotEvidence({
        indexedDbCache: {
          backend: 'indexeddb',
          databaseName: 'unzen-model-cache',
          segmentWeightKey: 'models/unzen-30b-q4/segment-03.bin',
          cacheHit: true,
          topLevelStorageAccessed: true,
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('indexeddb-cache-depends-on-top-level-storage');
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-indexeddb-cache-isolation-hardening']);
  });

  it('fails when checkpoint relay uses direct worker networking', () => {
    const report = runWorkersCoordinatorSignedRunnerWebGpuWorkerPilot({
      previewReport: createPreviewReport(),
      pilotEvidence: createPilotEvidence({
        checkpointRelay: {
          owner: 'coordinator-storage',
          checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
          relayUrl: 'https://coordinator.unzen.dev/checkpoints/signed-runner-webgpu-pilot/segment-03',
          directWorkerNetworking: true,
          topLevelDomAccessed: false,
          topLevelCookieAccessed: false,
          topLevelStorageAccessed: false,
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('checkpoint-relay-must-not-use-direct-worker-networking');
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-checkpoint-relay-isolation-hardening']);
  });

  it('fails when WebGPU execution leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorSignedRunnerWebGpuWorkerPilot({
      previewReport: createPreviewReport(),
      pilotEvidence: createPilotEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/checkpoints',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/segment-metrics',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'webgpu-pilot-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-webgpu-network-policy-hardening']);
  });
});
