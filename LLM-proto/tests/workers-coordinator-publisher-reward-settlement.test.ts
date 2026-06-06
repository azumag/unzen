import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorProductionWorkerFleetSloCostReport,
} from '../src/workers-coordinator-production-worker-fleet-slo-cost.js';
import {
  runWorkersCoordinatorPublisherRewardSettlementGate,
  type WorkersCoordinatorPublisherSettlementEvidence,
} from '../src/workers-coordinator-publisher-reward-settlement.js';

function createFleetSloCostReport(
  overrides: Partial<WorkersCoordinatorProductionWorkerFleetSloCostReport> = {},
): WorkersCoordinatorProductionWorkerFleetSloCostReport {
  const base: WorkersCoordinatorProductionWorkerFleetSloCostReport = {
    runtime: 'production-worker-fleet-slo-cost-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    deviceTierP95Latency: [
      {
        tier: 'desktop-discrete-gpu',
        sampleCount: 980,
        p95SegmentLatencyMs: 8_900,
        targetP95SegmentLatencyMs: 10_000,
      },
    ],
    fallbackBudget: {
      webGpuDeviceLossRate: 0.006,
      cpuFallbackRate: 0.018,
      maxWebGpuDeviceLossRate: 0.01,
      maxCpuFallbackRate: 0.03,
    },
    cacheWarmupCost: {
      currency: 'USD',
      indexedDbWarmupCostUsd: 38.42,
      hitMedianLoadMs: 19,
      missMedianLoadMs: 880,
      maxIndexedDbWarmupCostUsd: 50,
      maxMissPenaltyMs: 1_200,
    },
    checkpointRelaySpend: {
      currency: 'USD',
      coordinatorRelaySpendUsd: 74.12,
      retryRate: 0.012,
      failureRate: 0.002,
      maxCoordinatorRelaySpendUsd: 100,
      maxRetryRate: 0.02,
      maxFailureRate: 0.005,
    },
    userOptInImpact: {
      optedInWorkerCount: 18_400,
      eligibleWorkerCount: 40_000,
      optInRate: 0.46,
      minOptInRate: 0.35,
      estimatedPublisherRevenueLiftPct: 7.4,
      minPublisherRevenueLiftPct: 5,
    },
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: [
        'all device-tier p95 segment latency values are inside target',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons: [],
    },
    securityBoundaryDuringFleetAggregation: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/fleet-slo-cost',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-reward-and-abuse-resistant-settlement-gate'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createSettlementEvidence(
  overrides: Partial<WorkersCoordinatorPublisherSettlementEvidence> = {},
): WorkersCoordinatorPublisherSettlementEvidence {
  return {
    source: 'publisher-reward-settlement-aggregation',
    capturedAtMs: 1_779_668_020_000,
    rewardAccrualInputs: [
      {
        publisherId: 'publisher:newsroom-a',
        optedInWorkerId: 'worker:attested-desktop-001',
        segmentId: 'segment-03',
        checkpointClaimId: 'claim:checkpoint:segment-03:001',
        signedRunnerExecutionId: 'exec:signed-runner:segment-03:001',
        verifiedContributionMs: 8_900,
        rewardUsd: 4.25,
      },
      {
        publisherId: 'publisher:docs-b',
        optedInWorkerId: 'worker:attested-mobile-014',
        segmentId: 'segment-04',
        checkpointClaimId: 'claim:checkpoint:segment-04:001',
        signedRunnerExecutionId: 'exec:signed-runner:segment-04:001',
        verifiedContributionMs: 11_400,
        rewardUsd: 3.75,
      },
    ],
    checkpointClaims: [
      {
        claimId: 'claim:checkpoint:segment-03:001',
        checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
        coordinatorRelayUrl: 'https://coordinator.unzen.dev/checkpoints/settlement/segment-03',
        relayOwner: 'coordinator-storage',
        replayNonce: 'nonce:segment-03:001',
        observedAtMs: 1_779_668_021_000,
      },
      {
        claimId: 'claim:checkpoint:segment-04:001',
        checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-04',
        coordinatorRelayUrl: 'https://coordinator.unzen.dev/checkpoints/settlement/segment-04',
        relayOwner: 'coordinator-storage',
        replayNonce: 'nonce:segment-04:001',
        observedAtMs: 1_779_668_023_000,
      },
    ],
    signedRunnerExecutionLinks: [
      {
        executionId: 'exec:signed-runner:segment-03:001',
        runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
        segmentId: 'segment-03',
        signatureVerified: true,
        workerAttestationState: 'verified',
        topLevelDomAccessed: false,
        topLevelCookieAccessed: false,
        topLevelStorageAccessed: false,
      },
      {
        executionId: 'exec:signed-runner:segment-04:001',
        runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
        segmentId: 'segment-04',
        signatureVerified: true,
        workerAttestationState: 'verified',
        topLevelDomAccessed: false,
        topLevelCookieAccessed: false,
        topLevelStorageAccessed: false,
      },
    ],
    settlementBudget: {
      currency: 'USD',
      accruedRewardUsd: 8,
      maxRewardUsd: 12,
      coordinatorRelaySpendUsd: 2.2,
      maxCoordinatorRelaySpendUsd: 5,
    },
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'wss://coordinator.unzen.dev/settlement/socket',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/settlement',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    ],
    ...overrides,
  };
}

describe('Workers Coordinator publisher reward settlement gate', () => {
  it('promotes reward settlement when reward, checkpoint, signed runner, abuse, and security evidence pass', () => {
    const report = runWorkersCoordinatorPublisherRewardSettlementGate({
      fleetSloCostReport: createFleetSloCostReport(),
      settlementEvidence: createSettlementEvidence(),
    });

    expect(report.runtime).toBe('publisher-reward-abuse-resistant-settlement-gate');
    expect(report.status).toBe('pass');
    expect(report.previewRunnerUrl).toBe('https://preview.unzen-workers.example/runners/signed/runner.html');
    expect(report.rewardAccrualInputs).toEqual([
      expect.objectContaining({
        publisherId: 'publisher:newsroom-a',
        checkpointClaimId: 'claim:checkpoint:segment-03:001',
        signedRunnerExecutionId: 'exec:signed-runner:segment-03:001',
        rewardUsd: 4.25,
      }),
      expect.objectContaining({
        publisherId: 'publisher:docs-b',
        checkpointClaimId: 'claim:checkpoint:segment-04:001',
        rewardUsd: 3.75,
      }),
    ]);
    expect(report.checkpointRelayEvidence).toEqual([
      expect.objectContaining({
        claimId: 'claim:checkpoint:segment-03:001',
        relayOwner: 'coordinator-storage',
      }),
      expect.objectContaining({
        claimId: 'claim:checkpoint:segment-04:001',
        relayOwner: 'coordinator-storage',
      }),
    ]);
    expect(report.signedRunnerExecutionLinkage).toEqual([
      expect.objectContaining({
        executionId: 'exec:signed-runner:segment-03:001',
        signatureVerified: true,
        workerAttestationState: 'verified',
      }),
      expect.objectContaining({
        executionId: 'exec:signed-runner:segment-04:001',
        signatureVerified: true,
        workerAttestationState: 'verified',
      }),
    ]);
    expect(report.abuseDetectionResults).toEqual({
      spoofedWorkerClaims: [],
      replayedCheckpointClaims: [],
      duplicateSegmentContributionClaims: [],
      costShiftingClaims: [],
    });
    expect(report.publisherSettlementHoldReasons).toEqual([]);
    expect(report.settlementBudget).toMatchObject({
      accruedRewardUsd: 8,
      maxRewardUsd: 12,
      coordinatorRelaySpendUsd: 2.2,
    });
    expect(report.promoteHoldThresholds).toMatchObject({
      decision: 'promote',
      holdReasons: [],
    });
    expect(report.securityBoundaryDuringSettlement).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringSettlement.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/settlement',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-reward-pilot-ledger-and-payout-reconciliation']);
  });

  it('holds when the production fleet SLO and cost gate has not passed', () => {
    const report = runWorkersCoordinatorPublisherRewardSettlementGate({
      fleetSloCostReport: createFleetSloCostReport({
        status: 'fail',
        failureReason: 'fleet-user-opt-in-impact-below-production-threshold',
      }),
      settlementEvidence: createSettlementEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('fleet-slo-cost-gate-not-clean: fleet-user-opt-in-impact-below-production-threshold');
    expect(report.bottlenecksToIssue).toEqual([
      'publisher-reward-settlement-failure: fleet-slo-cost-gate-not-clean: fleet-user-opt-in-impact-below-production-threshold',
    ]);
  });

  it('holds when a worker attestation is spoofed', () => {
    const report = runWorkersCoordinatorPublisherRewardSettlementGate({
      fleetSloCostReport: createFleetSloCostReport(),
      settlementEvidence: createSettlementEvidence({
        signedRunnerExecutionLinks: [
          {
            executionId: 'exec:signed-runner:segment-03:001',
            runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
            segmentId: 'segment-03',
            signatureVerified: false,
            workerAttestationState: 'spoofed',
            topLevelDomAccessed: false,
            topLevelCookieAccessed: false,
            topLevelStorageAccessed: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.abuseDetectionResults.spoofedWorkerClaims).toEqual(['exec:signed-runner:segment-03:001']);
    expect(report.failureReason).toBe(
      'publisher-reward-missing-verified-signed-runner-execution: exec:signed-runner:segment-03:001',
    );
    expect(report.publisherSettlementHoldReasons).toContain(
      'publisher-settlement-spoofed-worker-claims: exec:signed-runner:segment-03:001',
    );
  });

  it('holds when checkpoint claims are replayed', () => {
    const report = runWorkersCoordinatorPublisherRewardSettlementGate({
      fleetSloCostReport: createFleetSloCostReport(),
      settlementEvidence: createSettlementEvidence({
        checkpointClaims: [
          {
            claimId: 'claim:checkpoint:segment-03:001',
            checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
            coordinatorRelayUrl: 'https://coordinator.unzen.dev/checkpoints/settlement/segment-03',
            relayOwner: 'coordinator-storage',
            replayNonce: 'nonce:replayed',
            observedAtMs: 1_779_668_021_000,
          },
          {
            claimId: 'claim:checkpoint:segment-04:001',
            checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-04',
            coordinatorRelayUrl: 'https://coordinator.unzen.dev/checkpoints/settlement/segment-04',
            relayOwner: 'coordinator-storage',
            replayNonce: 'nonce:replayed',
            observedAtMs: 1_779_668_023_000,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-settlement-replayed-checkpoint-claims: claim:checkpoint:segment-03:001,claim:checkpoint:segment-04:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-settlement-checkpoint-replay-hardening']);
  });

  it('holds when duplicate segment contribution claims are submitted', () => {
    const report = runWorkersCoordinatorPublisherRewardSettlementGate({
      fleetSloCostReport: createFleetSloCostReport(),
      settlementEvidence: createSettlementEvidence({
        rewardAccrualInputs: [
          {
            publisherId: 'publisher:newsroom-a',
            optedInWorkerId: 'worker:attested-desktop-001',
            segmentId: 'segment-03',
            checkpointClaimId: 'claim:checkpoint:segment-03:001',
            signedRunnerExecutionId: 'exec:signed-runner:segment-03:001',
            verifiedContributionMs: 8_900,
            rewardUsd: 4.25,
          },
          {
            publisherId: 'publisher:newsroom-a',
            optedInWorkerId: 'worker:attested-desktop-002',
            segmentId: 'segment-03',
            checkpointClaimId: 'claim:checkpoint:segment-03:duplicate',
            signedRunnerExecutionId: 'exec:signed-runner:segment-03:001',
            verifiedContributionMs: 8_850,
            rewardUsd: 3.75,
          },
        ],
        checkpointClaims: [
          {
            claimId: 'claim:checkpoint:segment-03:001',
            checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
            coordinatorRelayUrl: 'https://coordinator.unzen.dev/checkpoints/settlement/segment-03',
            relayOwner: 'coordinator-storage',
            replayNonce: 'nonce:segment-03:001',
            observedAtMs: 1_779_668_021_000,
          },
          {
            claimId: 'claim:checkpoint:segment-03:duplicate',
            checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
            coordinatorRelayUrl: 'https://coordinator.unzen.dev/checkpoints/settlement/segment-03-duplicate',
            relayOwner: 'coordinator-storage',
            replayNonce: 'nonce:segment-03:duplicate',
            observedAtMs: 1_779_668_023_000,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-settlement-duplicate-segment-contribution-claims: claim:checkpoint:segment-03:001,claim:checkpoint:segment-03:duplicate',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-settlement-duplicate-contribution-hardening']);
  });

  it('holds when settlement tries to shift relay cost to a non-Coordinator origin', () => {
    const report = runWorkersCoordinatorPublisherRewardSettlementGate({
      fleetSloCostReport: createFleetSloCostReport(),
      settlementEvidence: createSettlementEvidence({
        checkpointClaims: [
          {
            claimId: 'claim:checkpoint:segment-03:001',
            checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
            coordinatorRelayUrl: 'https://worker-direct.example.test/checkpoints/segment-03',
            relayOwner: 'worker-direct',
            replayNonce: 'nonce:segment-03:001',
            observedAtMs: 1_779_668_021_000,
          },
          {
            claimId: 'claim:checkpoint:segment-04:001',
            checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-04',
            coordinatorRelayUrl: 'https://coordinator.unzen.dev/checkpoints/settlement/segment-04',
            relayOwner: 'coordinator-storage',
            replayNonce: 'nonce:segment-04:001',
            observedAtMs: 1_779_668_023_000,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-reward-missing-coordinator-checkpoint-relay: claim:checkpoint:segment-03:001',
    );
    expect(report.publisherSettlementHoldReasons).toContain(
      'publisher-settlement-cost-shifting-claims: claim:checkpoint:segment-03:001',
    );
  });

  it('holds when settlement leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherRewardSettlementGate({
      fleetSloCostReport: createFleetSloCostReport(),
      settlementEvidence: createSettlementEvidence({
        networkAttempts: [
          {
            url: 'wss://coordinator.unzen.dev/settlement/socket',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/settlement',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-settlement-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual([
      'publisher-reward-settlement-failure: publisher-settlement-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    ]);
  });
});
