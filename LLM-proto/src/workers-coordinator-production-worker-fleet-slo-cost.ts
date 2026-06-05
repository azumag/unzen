import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorWebGpuWorkerPerformanceTelemetryReport,
} from './workers-coordinator-webgpu-worker-performance-telemetry.js';

export interface WorkersCoordinatorFleetDeviceTierSlo {
  readonly tier: 'desktop-discrete-gpu' | 'desktop-integrated-gpu' | 'mobile-gpu' | 'cpu-fallback';
  readonly sampleCount: number;
  readonly p95SegmentLatencyMs: number;
  readonly targetP95SegmentLatencyMs: number;
}

export interface WorkersCoordinatorFleetFallbackBudget {
  readonly webGpuDeviceLossRate: number;
  readonly cpuFallbackRate: number;
  readonly maxWebGpuDeviceLossRate: number;
  readonly maxCpuFallbackRate: number;
}

export interface WorkersCoordinatorFleetCacheCost {
  readonly currency: 'USD';
  readonly indexedDbWarmupCostUsd: number;
  readonly hitMedianLoadMs: number;
  readonly missMedianLoadMs: number;
  readonly maxIndexedDbWarmupCostUsd: number;
  readonly maxMissPenaltyMs: number;
}

export interface WorkersCoordinatorFleetCheckpointRelaySpend {
  readonly currency: 'USD';
  readonly coordinatorRelaySpendUsd: number;
  readonly retryRate: number;
  readonly failureRate: number;
  readonly maxCoordinatorRelaySpendUsd: number;
  readonly maxRetryRate: number;
  readonly maxFailureRate: number;
}

export interface WorkersCoordinatorFleetOptInImpact {
  readonly optedInWorkerCount: number;
  readonly eligibleWorkerCount: number;
  readonly optInRate: number;
  readonly minOptInRate: number;
  readonly estimatedPublisherRevenueLiftPct: number;
  readonly minPublisherRevenueLiftPct: number;
}

export interface WorkersCoordinatorFleetThresholds {
  readonly decision: 'promote' | 'hold';
  readonly promoteWhen: readonly string[];
  readonly holdReasons: readonly string[];
}

export interface WorkersCoordinatorProductionWorkerFleetEvidence {
  readonly source: 'production-worker-fleet-slo-cost-aggregation';
  readonly capturedAtMs: number;
  readonly deviceTierSlo: readonly WorkersCoordinatorFleetDeviceTierSlo[];
  readonly fallbackBudget: WorkersCoordinatorFleetFallbackBudget;
  readonly cacheCost: WorkersCoordinatorFleetCacheCost;
  readonly checkpointRelaySpend: WorkersCoordinatorFleetCheckpointRelaySpend;
  readonly optInImpact: WorkersCoordinatorFleetOptInImpact;
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorProductionWorkerFleetSloCostOptions {
  readonly telemetryReport: WorkersCoordinatorWebGpuWorkerPerformanceTelemetryReport;
  readonly fleetEvidence: WorkersCoordinatorProductionWorkerFleetEvidence;
}

export interface WorkersCoordinatorProductionWorkerFleetSloCostReport {
  readonly runtime: 'production-worker-fleet-slo-cost-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly deviceTierP95Latency: readonly WorkersCoordinatorFleetDeviceTierSlo[];
  readonly fallbackBudget: WorkersCoordinatorFleetFallbackBudget;
  readonly cacheWarmupCost: WorkersCoordinatorFleetCacheCost;
  readonly checkpointRelaySpend: WorkersCoordinatorFleetCheckpointRelaySpend;
  readonly userOptInImpact: WorkersCoordinatorFleetOptInImpact;
  readonly promoteHoldThresholds: WorkersCoordinatorFleetThresholds;
  readonly securityBoundaryDuringFleetAggregation: {
    readonly cspConnectSrc: readonly string[];
    readonly sandboxFlags: readonly string[];
    readonly coop: string | null;
    readonly coep: string | null;
    readonly allowedOrigins: readonly string[];
    readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
  };
  readonly failureReason?: string;
  readonly bottlenecksToIssue: readonly string[];
}

export function runWorkersCoordinatorProductionWorkerFleetSloCostGate(
  options: WorkersCoordinatorProductionWorkerFleetSloCostOptions,
): WorkersCoordinatorProductionWorkerFleetSloCostReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.fleetEvidence);
  const holdReasons = selectHoldReasons({
    telemetryReport: options.telemetryReport,
    fleetEvidence: options.fleetEvidence,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'production-worker-fleet-slo-cost-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.telemetryReport.previewRunnerUrl,
    deviceTierP95Latency: options.fleetEvidence.deviceTierSlo,
    fallbackBudget: options.fleetEvidence.fallbackBudget,
    cacheWarmupCost: options.fleetEvidence.cacheCost,
    checkpointRelaySpend: options.fleetEvidence.checkpointRelaySpend,
    userOptInImpact: options.fleetEvidence.optInImpact,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'all device-tier p95 segment latency values are inside target',
        'WebGPU device loss and CPU fallback rates stay inside fleet budget',
        'IndexedDB warmup and miss penalty stay inside cost budget',
        'Coordinator checkpoint relay spend, retry rate, and failure rate stay inside budget',
        'user opt-in rate and publisher revenue lift clear production thresholds',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons,
    },
    securityBoundaryDuringFleetAggregation: {
      cspConnectSrc: options.fleetEvidence.cspConnectSrc,
      sandboxFlags: options.fleetEvidence.sandboxFlags,
      coop: options.fleetEvidence.coop,
      coep: options.fleetEvidence.coep,
      allowedOrigins: options.fleetEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: {
  readonly telemetryReport: WorkersCoordinatorWebGpuWorkerPerformanceTelemetryReport;
  readonly fleetEvidence: WorkersCoordinatorProductionWorkerFleetEvidence;
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.telemetryReport.status === 'fail') {
    return [`webgpu-worker-telemetry-not-clean: ${input.telemetryReport.failureReason ?? 'unknown'}`];
  }
  if (input.fleetEvidence.source !== 'production-worker-fleet-slo-cost-aggregation') {
    return ['fleet-slo-cost-gate-must-use-production-aggregation-evidence'];
  }
  if (input.fleetEvidence.deviceTierSlo.length === 0) {
    return ['device-tier-p95-latency-missing'];
  }

  const holdReasons: string[] = [];
  const failingTier = input.fleetEvidence.deviceTierSlo.find((tier) =>
    !isPositiveInteger(tier.sampleCount) ||
    !isNonNegativeFinite(tier.p95SegmentLatencyMs) ||
    !isNonNegativeFinite(tier.targetP95SegmentLatencyMs) ||
    tier.p95SegmentLatencyMs > tier.targetP95SegmentLatencyMs,
  );
  if (failingTier) {
    holdReasons.push(`device-tier-p95-latency-over-slo: ${failingTier.tier}`);
  }
  if (
    input.fleetEvidence.fallbackBudget.webGpuDeviceLossRate >
      input.fleetEvidence.fallbackBudget.maxWebGpuDeviceLossRate ||
    input.fleetEvidence.fallbackBudget.cpuFallbackRate >
      input.fleetEvidence.fallbackBudget.maxCpuFallbackRate ||
    !isRateBudget(input.fleetEvidence.fallbackBudget.webGpuDeviceLossRate) ||
    !isRateBudget(input.fleetEvidence.fallbackBudget.cpuFallbackRate) ||
    !isRateBudget(input.fleetEvidence.fallbackBudget.maxWebGpuDeviceLossRate) ||
    !isRateBudget(input.fleetEvidence.fallbackBudget.maxCpuFallbackRate)
  ) {
    holdReasons.push('fleet-webgpu-device-loss-or-cpu-fallback-rate-over-budget');
  }
  const cacheMissPenaltyMs =
    input.fleetEvidence.cacheCost.missMedianLoadMs - input.fleetEvidence.cacheCost.hitMedianLoadMs;
  if (
    input.fleetEvidence.cacheCost.currency !== 'USD' ||
    input.fleetEvidence.cacheCost.indexedDbWarmupCostUsd >
      input.fleetEvidence.cacheCost.maxIndexedDbWarmupCostUsd ||
    cacheMissPenaltyMs > input.fleetEvidence.cacheCost.maxMissPenaltyMs ||
    !isNonNegativeFinite(input.fleetEvidence.cacheCost.indexedDbWarmupCostUsd) ||
    !isNonNegativeFinite(input.fleetEvidence.cacheCost.maxIndexedDbWarmupCostUsd) ||
    !isNonNegativeFinite(input.fleetEvidence.cacheCost.hitMedianLoadMs) ||
    !isNonNegativeFinite(input.fleetEvidence.cacheCost.missMedianLoadMs) ||
    !isNonNegativeFinite(input.fleetEvidence.cacheCost.maxMissPenaltyMs) ||
    !isNonNegativeFinite(cacheMissPenaltyMs)
  ) {
    holdReasons.push('fleet-cache-warmup-cost-or-miss-penalty-over-budget');
  }
  if (
    input.fleetEvidence.checkpointRelaySpend.currency !== 'USD' ||
    input.fleetEvidence.checkpointRelaySpend.coordinatorRelaySpendUsd >
      input.fleetEvidence.checkpointRelaySpend.maxCoordinatorRelaySpendUsd ||
    input.fleetEvidence.checkpointRelaySpend.retryRate >
      input.fleetEvidence.checkpointRelaySpend.maxRetryRate ||
    input.fleetEvidence.checkpointRelaySpend.failureRate >
      input.fleetEvidence.checkpointRelaySpend.maxFailureRate ||
    !isNonNegativeFinite(input.fleetEvidence.checkpointRelaySpend.coordinatorRelaySpendUsd) ||
    !isNonNegativeFinite(input.fleetEvidence.checkpointRelaySpend.maxCoordinatorRelaySpendUsd) ||
    !isRateBudget(input.fleetEvidence.checkpointRelaySpend.retryRate) ||
    !isRateBudget(input.fleetEvidence.checkpointRelaySpend.failureRate) ||
    !isRateBudget(input.fleetEvidence.checkpointRelaySpend.maxRetryRate) ||
    !isRateBudget(input.fleetEvidence.checkpointRelaySpend.maxFailureRate)
  ) {
    holdReasons.push('fleet-checkpoint-relay-spend-retry-or-failure-over-budget');
  }
  if (
    !isPositiveInteger(input.fleetEvidence.optInImpact.eligibleWorkerCount) ||
    !isNonNegativeInteger(input.fleetEvidence.optInImpact.optedInWorkerCount) ||
    input.fleetEvidence.optInImpact.optedInWorkerCount > input.fleetEvidence.optInImpact.eligibleWorkerCount ||
    input.fleetEvidence.optInImpact.optInRate < input.fleetEvidence.optInImpact.minOptInRate ||
    input.fleetEvidence.optInImpact.estimatedPublisherRevenueLiftPct <
      input.fleetEvidence.optInImpact.minPublisherRevenueLiftPct ||
    !isRateBudget(input.fleetEvidence.optInImpact.optInRate) ||
    !isRateBudget(input.fleetEvidence.optInImpact.minOptInRate) ||
    !isNonNegativeFinite(input.fleetEvidence.optInImpact.estimatedPublisherRevenueLiftPct) ||
    !isNonNegativeFinite(input.fleetEvidence.optInImpact.minPublisherRevenueLiftPct)
  ) {
    holdReasons.push('fleet-user-opt-in-impact-below-production-threshold');
  }
  if (!input.fleetEvidence.allowedOrigins.every((origin) => input.fleetEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('fleet-slo-cost-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.fleetEvidence.sandboxFlags.length === 1 && input.fleetEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('fleet-slo-cost-sandbox-must-remain-allow-scripts-only');
  }
  if (input.fleetEvidence.coop !== 'same-origin' || input.fleetEvidence.coep !== 'require-corp') {
    holdReasons.push('fleet-slo-cost-cross-origin-isolation-lost');
  }
  const leakedNetworkAttempt = input.fleetEvidence.networkAttempts.find((attempt) =>
    !input.fleetEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`fleet-slo-cost-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('fleet-slo-cost-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  return holdReasons;
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorProductionWorkerFleetEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.startsWith('device-tier-p95-latency')) {
    return ['production-fleet-device-tier-slo-hardening'];
  }
  if (failureReason?.startsWith('fleet-webgpu-device-loss') || failureReason?.includes('cpu-fallback')) {
    return ['production-fleet-fallback-budget-hardening'];
  }
  if (failureReason?.startsWith('fleet-cache')) {
    return ['production-fleet-cache-cost-hardening'];
  }
  if (failureReason?.startsWith('fleet-checkpoint-relay')) {
    return ['production-fleet-checkpoint-relay-cost-hardening'];
  }
  if (failureReason?.startsWith('fleet-user-opt-in')) {
    return ['production-fleet-opt-in-threshold-hardening'];
  }
  if (failureReason) {
    return [`production-worker-fleet-slo-cost-failure: ${failureReason}`];
  }
  return ['publisher-reward-and-abuse-resistant-settlement-gate'];
}

function isRateBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
