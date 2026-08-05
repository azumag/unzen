import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport,
} from '../src/workers-coordinator-signed-runner-webgpu-worker-pilot.js';
import {
  runWorkersCoordinatorWebGpuWorkerPerformanceTelemetry,
  type WorkersCoordinatorWebGpuWorkerPerformanceTelemetryEvidencePayload,
  type WorkersCoordinatorWebGpuWorkerPerformanceTelemetryReport,
} from '../src/workers-coordinator-webgpu-worker-performance-telemetry.js';
import {
  createCapturedAndVerifiedEnvelope,
  createProductionClaimingSyntheticEnvelope,
  createSyntheticEnvelope,
  createVerifiedValidationOptions,
  type WorkersCoordinatorSignedRunnerEvidenceProvenance,
} from './evidence-envelope-helpers.js';

function createPilotReport(
  overrides: Partial<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport> = {},
  evidence: Partial<WorkersCoordinatorSignedRunnerEvidenceProvenance> = {},
): WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport {
  const base: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport = {
    runtime: 'signed-runner-webgpu-worker-pilot',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    evidence: {
      validationStatus: 'valid',
      evidenceKind: 'signed-runner-contract',
      evidenceLevel: 'synthetic-fixture',
      readinessStatus: 'contract-tested',
      producerName: 'vitest',
      producerVersion: '4.1.7',
      runId: 'synthetic-run-1',
      capturedAt: '2026-07-10T13:00:00.000Z',
      issueCodes: [],
      ...evidence,
    },
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
    securityBoundaryDuringExecution: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/segment-metrics',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['webgpu-worker-performance-and-fallback-telemetry'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createTelemetryEvidencePayload(
  overrides: Partial<WorkersCoordinatorWebGpuWorkerPerformanceTelemetryEvidencePayload> = {},
): WorkersCoordinatorWebGpuWorkerPerformanceTelemetryEvidencePayload {
  return {
    runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    segmentLatencySamplesMs: [8_900, 8_720, 9_040, 8_830, 9_180],
    indexedDbCacheTiming: {
      backend: 'indexeddb',
      cacheHit: true,
      hitLoadMs: 18,
      topLevelStorageAccessed: false,
    },
    checkpointRelayTiming: {
      owner: 'coordinator-storage',
      durationMs: 42,
      retryCount: 0,
      failureReasons: [],
      directWorkerNetworking: false,
      topLevelDomAccessed: false,
      topLevelCookieAccessed: false,
      topLevelStorageAccessed: false,
    },
    webGpuDeviceLoss: {
      state: 'not-lost',
    },
    cpuFallbackRouting: {
      decision: 'not-needed',
    },
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'wss://coordinator.unzen.dev/workers/webgpu-telemetry/socket',
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

async function runTelemetry(options: {
  pilotReport?: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport;
  telemetryEvidenceEnvelope?: Parameters<typeof runWorkersCoordinatorWebGpuWorkerPerformanceTelemetry>[0]['telemetryEvidenceEnvelope'];
  evidenceValidation?: Parameters<typeof runWorkersCoordinatorWebGpuWorkerPerformanceTelemetry>[0]['evidenceValidation'];
} = {}): Promise<WorkersCoordinatorWebGpuWorkerPerformanceTelemetryReport> {
  return runWorkersCoordinatorWebGpuWorkerPerformanceTelemetry({
    pilotReport: options.pilotReport ?? createPilotReport(),
    telemetryEvidenceEnvelope: options.telemetryEvidenceEnvelope
      ?? createSyntheticEnvelope(createTelemetryEvidencePayload()),
    evidenceValidation: options.evidenceValidation ?? { now: '2026-07-10T14:00:00.000Z' },
  });
}

describe('Workers Coordinator WebGPU worker performance telemetry contract', () => {
  it('passes segment latency, cache, checkpoint, fallback, and signed runner boundary telemetry at contract-tested', async () => {
    const report = await runTelemetry();

    expect(report.runtime).toBe('webgpu-worker-performance-fallback-telemetry');
    expect(report.status).toBe('pass');
    expect(report.previewRunnerUrl).toBe('https://preview.unzen-workers.example/runners/signed/runner.html');
    expect(report.evidence).toMatchObject({
      validationStatus: 'valid',
      evidenceLevel: 'synthetic-fixture',
      readinessStatus: 'contract-tested',
      issueCodes: [],
    });
    expect(report.segmentLatencyDistribution).toEqual({
      sampleCount: 5,
      minMs: 8_720,
      p50Ms: 8_900,
      p95Ms: 9_180,
      maxMs: 9_180,
    });
    expect(report.indexedDbCacheTiming).toMatchObject({
      backend: 'indexeddb',
      cacheHit: true,
      hitLoadMs: 18,
      topLevelStorageAccessed: false,
    });
    expect(report.checkpointRelayTiming).toMatchObject({
      owner: 'coordinator-storage',
      durationMs: 42,
      retryCount: 0,
      failureReasons: [],
      directWorkerNetworking: false,
    });
    expect(report.webGpuDeviceLoss).toEqual({ state: 'not-lost' });
    expect(report.cpuFallbackRouting).toEqual({ decision: 'not-needed' });
    expect(report.securityBoundaryDuringTelemetry).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringTelemetry?.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/segment-metrics',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['production-worker-fleet-slo-and-cost-gate']);
  });

  it('passes when WebGPU device loss is routed to the CPU fallback worker', async () => {
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createSyntheticEnvelope(
        createTelemetryEvidencePayload({
          webGpuDeviceLoss: {
            state: 'lost',
            reason: 'GPU device removed during sustained segment execution',
          },
          cpuFallbackRouting: {
            decision: 'route-to-cpu',
            reason: 'preserve request progress after device loss',
            targetRuntime: 'cpu-worker',
          },
        }),
      ),
    });

    expect(report.status).toBe('pass');
    expect(report.webGpuDeviceLoss).toMatchObject({
      state: 'lost',
      reason: 'GPU device removed during sustained segment execution',
    });
    expect(report.cpuFallbackRouting).toMatchObject({
      decision: 'route-to-cpu',
      targetRuntime: 'cpu-worker',
    });
  });

  it('fails when latency samples are missing', async () => {
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createSyntheticEnvelope(
        createTelemetryEvidencePayload({ segmentLatencySamplesMs: [] }),
      ),
    });

    expect(report.status).toBe('fail');
    expect(report.segmentLatencyDistribution).toBeNull();
    expect(report.failureReason).toBe('segment-latency-distribution-missing-or-invalid');
    expect(report.bottlenecksToIssue).toEqual(['webgpu-worker-latency-instrumentation-hardening']);
  });

  it('fails when cache timing depends on top-level page storage', async () => {
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createSyntheticEnvelope(
        createTelemetryEvidencePayload({
          indexedDbCacheTiming: {
            backend: 'indexeddb',
            cacheHit: true,
            hitLoadMs: 18,
            topLevelStorageAccessed: true,
          },
        }),
      ),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('cache-timing-depends-on-top-level-storage');
    expect(report.bottlenecksToIssue).toEqual(['webgpu-worker-cache-telemetry-hardening']);
  });

  it('fails when cache hit timing is invalid', async () => {
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createSyntheticEnvelope(
        createTelemetryEvidencePayload({
          indexedDbCacheTiming: {
            backend: 'indexeddb',
            cacheHit: true,
            hitLoadMs: -1,
            topLevelStorageAccessed: false,
          },
        }),
      ),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('cache-hit-timing-missing');
    expect(report.bottlenecksToIssue).toEqual(['webgpu-worker-cache-telemetry-hardening']);
  });

  it('fails when checkpoint relay timing uses direct worker networking', async () => {
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createSyntheticEnvelope(
        createTelemetryEvidencePayload({
          checkpointRelayTiming: {
            owner: 'coordinator-storage',
            durationMs: 42,
            retryCount: 1,
            failureReasons: ['first coordinator relay attempt timed out'],
            directWorkerNetworking: true,
            topLevelDomAccessed: false,
            topLevelCookieAccessed: false,
            topLevelStorageAccessed: false,
          },
        }),
      ),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('checkpoint-relay-timing-must-not-use-direct-worker-networking');
    expect(report.bottlenecksToIssue).toEqual(['webgpu-worker-checkpoint-relay-telemetry-hardening']);
  });

  it('fails when checkpoint relay retry count is invalid', async () => {
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createSyntheticEnvelope(
        createTelemetryEvidencePayload({
          checkpointRelayTiming: {
            owner: 'coordinator-storage',
            durationMs: 42,
            retryCount: -1,
            failureReasons: [],
            directWorkerNetworking: false,
            topLevelDomAccessed: false,
            topLevelCookieAccessed: false,
            topLevelStorageAccessed: false,
          },
        }),
      ),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('checkpoint-relay-retry-count-invalid');
    expect(report.bottlenecksToIssue).toEqual(['webgpu-worker-checkpoint-relay-telemetry-hardening']);
  });

  it('fails when WebGPU device loss has no CPU fallback route', async () => {
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createSyntheticEnvelope(
        createTelemetryEvidencePayload({
          webGpuDeviceLoss: {
            state: 'lost',
            reason: 'GPU device removed during sustained segment execution',
          },
          cpuFallbackRouting: {
            decision: 'disabled',
            reason: 'fallback pool unavailable',
          },
        }),
      ),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('webgpu-device-loss-without-cpu-fallback-routing');
    expect(report.bottlenecksToIssue).toEqual(['webgpu-worker-device-loss-fallback-hardening']);
  });

  it('fails when telemetry leaks a non-Coordinator/CDN network attempt', async () => {
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createSyntheticEnvelope(
        createTelemetryEvidencePayload({
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
      ),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'webgpu-worker-telemetry-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['webgpu-worker-telemetry-network-policy-hardening']);
  });
});

describe('Workers Coordinator WebGPU worker performance telemetry integration gate', () => {
  it('rejects a hand-written captured-and-verified envelope without artifact loader and verifier callbacks', async () => {
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createCapturedAndVerifiedEnvelope(
        createTelemetryEvidencePayload(),
      ),
      evidenceValidation: {
        now: '2026-07-10T14:00:00.000Z',
        trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
      },
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'webgpu-worker-telemetry-evidence-not-validated: artifact-unavailable',
    );
    expect(report.evidence.validationStatus).toBe('not-evaluated');
    expect(report.evidence.issueCodes).toContain('artifact-unavailable');
    expect(report.segmentLatencyDistribution).toBeUndefined();
  });

  it('rejects a synthetic-fixture envelope that claims production readiness', async () => {
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createProductionClaimingSyntheticEnvelope(
        createTelemetryEvidencePayload(),
      ),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'webgpu-worker-telemetry-evidence-not-validated: readiness-exceeds-evidence-level',
    );
    expect(report.evidence.issueCodes).toContain('readiness-exceeds-evidence-level');
  });

  it('accepts captured-and-verified evidence only with trusted loader, verifier, and attestation', async () => {
    const report = await runTelemetry({
      pilotReport: createPilotReport({}, {
        evidenceLevel: 'captured-and-verified',
        readinessStatus: 'production-candidate',
        validationStatus: 'valid',
      }),
      telemetryEvidenceEnvelope: createCapturedAndVerifiedEnvelope(
        createTelemetryEvidencePayload(),
      ),
      evidenceValidation: createVerifiedValidationOptions(),
    });

    expect(report.status).toBe('pass');
    expect(report.evidence).toMatchObject({
      validationStatus: 'valid',
      evidenceLevel: 'captured-and-verified',
      readinessStatus: 'production-candidate',
    });
    expect(report.failureReason).toBeUndefined();
  });

  it('caps the reported readiness when the pilot upstream is only contract-tested', async () => {
    // Even captured-and-verified telemetry cannot be reported as
    // production-ready while the upstream pilot report is synthetic.
    const report = await runTelemetry({
      telemetryEvidenceEnvelope: createCapturedAndVerifiedEnvelope(
        createTelemetryEvidencePayload(),
      ),
      evidenceValidation: createVerifiedValidationOptions(),
    });

    expect(report.status).toBe('pass');
    expect(report.evidence.evidenceLevel).toBe('captured-and-verified');
    expect(report.evidence.readinessStatus).toBe('contract-tested');
  });
});
