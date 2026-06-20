import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport,
} from './workers-coordinator-publisher-tax-production-cutover-readiness.js';

export interface WorkersCoordinatorPublisherTaxProductionProviderCallback {
  readonly callbackId: string;
  readonly providerFilingId: string;
  readonly providerTraceId: string;
  readonly productionWindowId: string;
  readonly receivedAtMs: number;
  readonly signatureVerified: boolean;
  readonly eventType: 'filing.accepted' | 'filing.rejected' | 'filing.corrected' | 'filing.duplicate_suppressed';
  readonly duplicateFilingSuppressed: boolean;
}

export interface WorkersCoordinatorPublisherTaxProductionCallbacksEvidence {
  readonly source: 'publisher-tax-filing-production-callbacks-readiness';
  readonly capturedAtMs: number;
  readonly callbacksEnabledByApprovalId: string;
  readonly productionProviderCallbacks: readonly WorkersCoordinatorPublisherTaxProductionProviderCallback[];
  readonly duplicateFilingSuppressionIds: readonly string[];
  readonly rollbackPlanIds: readonly string[];
  readonly emergencyHoldSwitchIds: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxProductionCallbacksReadinessOptions {
  readonly productionCutoverReport: WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport;
  readonly productionCallbacksEvidence: WorkersCoordinatorPublisherTaxProductionCallbacksEvidence;
}

export interface WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport {
  readonly runtime: 'publisher-tax-filing-production-callbacks-readiness-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly cutoverApprovalEvidence: WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport['operatorApprovalEvidence'];
  readonly productionFilingWindow: WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport['productionFilingWindow'];
  readonly productionProviderCallbacks: readonly WorkersCoordinatorPublisherTaxProductionProviderCallback[];
  readonly productionCallbacksSummary: {
    readonly callbackCount: number;
    readonly signedCallbackCount: number;
    readonly approvedWindowCallbackCount: number;
    readonly duplicateFilingSuppressionCount: number;
    readonly rollbackControlCount: number;
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringProductionCallbacks: {
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

export function runWorkersCoordinatorPublisherTaxProductionCallbacksReadinessGate(
  options: WorkersCoordinatorPublisherTaxProductionCallbacksReadinessOptions,
): WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.productionCallbacksEvidence);
  const productionCallbacksSummary = summarizeProductionCallbacks(options);
  const holdReasons = selectHoldReasons({
    ...options,
    productionCallbacksSummary,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-tax-filing-production-callbacks-readiness-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.productionCutoverReport.previewRunnerUrl,
    cutoverApprovalEvidence: options.productionCutoverReport.operatorApprovalEvidence,
    productionFilingWindow: options.productionCutoverReport.productionFilingWindow,
    productionProviderCallbacks: options.productionCallbacksEvidence.productionProviderCallbacks,
    productionCallbacksSummary,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher tax production cutover readiness gate has already passed',
        'production callbacks are enabled by the approved cutover operator approval ID',
        'signed production provider callback IDs reconcile to the approved filing window and sandbox provider filing IDs',
        'duplicate-filing suppression remains active during callback ingestion',
        'rollback and emergency hold controls remain linked during callback ingestion',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact during production callbacks readiness',
      ],
      holdReasons,
    },
    securityBoundaryDuringProductionCallbacks: {
      cspConnectSrc: options.productionCallbacksEvidence.cspConnectSrc,
      sandboxFlags: options.productionCallbacksEvidence.sandboxFlags,
      coop: options.productionCallbacksEvidence.coop,
      coep: options.productionCallbacksEvidence.coep,
      allowedOrigins: options.productionCallbacksEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherTaxProductionCallbacksReadinessOptions & {
  readonly productionCallbacksSummary: WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport['productionCallbacksSummary'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.productionCutoverReport.status === 'fail') {
    return [`publisher-tax-production-cutover-readiness-gate-not-clean: ${input.productionCutoverReport.failureReason ?? 'unknown'}`];
  }
  if (input.productionCallbacksEvidence.source !== 'publisher-tax-filing-production-callbacks-readiness') {
    return ['publisher-tax-production-callbacks-readiness-must-use-production-callbacks-evidence'];
  }

  const holdReasons: string[] = [];
  const approval = input.productionCutoverReport.operatorApprovalEvidence;
  const window = input.productionCutoverReport.productionFilingWindow;

  if (input.productionCallbacksEvidence.callbacksEnabledByApprovalId !== approval.approvalId ||
    window.environment !== 'production' ||
    window.filingMode !== 'preflight-only' ||
    window.productionCallbacksEnabled ||
    input.productionCallbacksEvidence.capturedAtMs < window.callbackEnableAtMs
  ) {
    holdReasons.push(`publisher-tax-production-callbacks-cutover-approval-invalid: ${input.productionCallbacksEvidence.callbacksEnabledByApprovalId || 'unknown'}`);
  }

  const invalidCallback = input.productionCallbacksEvidence.productionProviderCallbacks.find((callback) =>
    callback.callbackId.length === 0 ||
    callback.providerFilingId.length === 0 ||
    !approval.approvedSandboxProviderFilingIds.includes(callback.providerFilingId) ||
    callback.providerTraceId.length === 0 ||
    callback.productionWindowId !== window.windowId ||
    !isPositiveFinite(callback.receivedAtMs) ||
    callback.receivedAtMs < window.callbackEnableAtMs ||
    !callback.signatureVerified ||
    !callback.duplicateFilingSuppressed
  );
  if (invalidCallback || input.productionCallbacksEvidence.productionProviderCallbacks.length === 0) {
    holdReasons.push(`publisher-tax-production-callbacks-invalid: ${invalidCallback?.callbackId ?? 'missing'}`);
  }

  if (window.duplicateFilingSuppressionIds.length === 0 ||
    window.duplicateFilingSuppressionIds.some((suppressionId) =>
      !input.productionCallbacksEvidence.duplicateFilingSuppressionIds.includes(suppressionId),
    ) ||
    approval.duplicateFilingSuppressionIds.some((suppressionId) =>
      !input.productionCallbacksEvidence.duplicateFilingSuppressionIds.includes(suppressionId),
    )
  ) {
    holdReasons.push('publisher-tax-production-callbacks-duplicate-filing-suppression-not-linked');
  }

  if (!input.productionCallbacksEvidence.rollbackPlanIds.includes(approval.rollbackPlanId) ||
    !input.productionCallbacksEvidence.emergencyHoldSwitchIds.includes(approval.emergencyHoldSwitchId)
  ) {
    holdReasons.push('publisher-tax-production-callbacks-rollback-hold-controls-not-linked');
  }

  const leakedNetworkAttempt = input.productionCallbacksEvidence.networkAttempts.find((attempt) =>
    !input.productionCallbacksEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-tax-production-callbacks-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-tax-production-callbacks-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.productionCallbacksEvidence.allowedOrigins.every((origin) => input.productionCallbacksEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-tax-production-callbacks-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.productionCallbacksEvidence.sandboxFlags.length === 1 && input.productionCallbacksEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-tax-production-callbacks-sandbox-must-remain-allow-scripts-only');
  }
  if (input.productionCallbacksEvidence.coop !== 'same-origin' || input.productionCallbacksEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-tax-production-callbacks-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function summarizeProductionCallbacks(
  options: WorkersCoordinatorPublisherTaxProductionCallbacksReadinessOptions,
): WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport['productionCallbacksSummary'] {
  return {
    callbackCount: options.productionCallbacksEvidence.productionProviderCallbacks.length,
    signedCallbackCount: options.productionCallbacksEvidence.productionProviderCallbacks.filter((callback) =>
      callback.signatureVerified,
    ).length,
    approvedWindowCallbackCount: options.productionCallbacksEvidence.productionProviderCallbacks.filter((callback) =>
      callback.productionWindowId === options.productionCutoverReport.productionFilingWindow.windowId,
    ).length,
    duplicateFilingSuppressionCount: options.productionCallbacksEvidence.duplicateFilingSuppressionIds.length,
    rollbackControlCount: options.productionCallbacksEvidence.rollbackPlanIds.length +
      options.productionCallbacksEvidence.emergencyHoldSwitchIds.length,
  };
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherTaxProductionCallbacksEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('cutover-approval')) {
    return ['publisher-tax-production-callbacks-cutover-approval-hardening'];
  }
  if (failureReason?.includes('callbacks-invalid') || failureReason?.includes('signature')) {
    return ['publisher-tax-production-callbacks-signature-reconciliation-hardening'];
  }
  if (failureReason?.includes('duplicate')) {
    return ['publisher-tax-production-callbacks-duplicate-suppression-hardening'];
  }
  if (failureReason?.includes('rollback') || failureReason?.includes('hold')) {
    return ['publisher-tax-production-callbacks-rollback-hold-hardening'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-tax-production-callbacks-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-tax-production-callbacks-readiness-failure: ${failureReason}`];
  }
  return ['publisher-tax-filing-production-monitoring-reconciliation'];
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
