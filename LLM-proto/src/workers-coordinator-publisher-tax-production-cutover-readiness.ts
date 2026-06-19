import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherTaxProviderSandboxFilingReport,
} from './workers-coordinator-publisher-tax-provider-sandbox-filing.js';

export interface WorkersCoordinatorPublisherTaxProductionCutoverOperatorApproval {
  readonly approvalId: string;
  readonly operatorId: string;
  readonly approvedAtMs: number;
  readonly productionWindowId: string;
  readonly approvedSandboxProviderFilingIds: readonly string[];
  readonly duplicateFilingSuppressionIds: readonly string[];
  readonly rollbackPlanId: string;
  readonly emergencyHoldSwitchId: string;
}

export interface WorkersCoordinatorPublisherTaxProductionFilingWindow {
  readonly windowId: string;
  readonly provider: 'irs-fire' | 'stripe-tax';
  readonly environment: 'production';
  readonly opensAtMs: number;
  readonly closesAtMs: number;
  readonly callbackEnableAtMs: number;
  readonly filingMode: 'preflight-only';
  readonly duplicateFilingSuppressionIds: readonly string[];
  readonly liveMoneyMovementSuppressed: boolean;
  readonly productionCallbacksEnabled: boolean;
}

export interface WorkersCoordinatorPublisherTaxLiveProviderPreflight {
  readonly preflightId: string;
  readonly provider: 'irs-fire' | 'stripe-tax';
  readonly endpointMode: 'production-preflight';
  readonly providerAccountId: string;
  readonly checkedAtMs: number;
  readonly dryRun: boolean;
  readonly wouldSubmitFiling: boolean;
  readonly duplicateFilingSuppressed: boolean;
  readonly providerTraceId: string;
}

export interface WorkersCoordinatorPublisherTaxProductionCutoverPreservedSandboxEvidence {
  readonly acceptedProviderFilingIds: readonly string[];
  readonly rejectedProviderFilingIds: readonly string[];
  readonly retryEvidenceIds: readonly string[];
  readonly publisherDeliveryIds: readonly string[];
  readonly correctedFormWorkflowIds: readonly string[];
  readonly postFilingAuditIds: readonly string[];
}

export interface WorkersCoordinatorPublisherTaxProductionCutoverEmergencyReadiness {
  readonly emergencyControlIds: readonly string[];
  readonly rollbackPlanIds: readonly string[];
  readonly emergencyHoldSwitchIds: readonly string[];
  readonly verifiedAtMs: number;
  readonly productionCallbacksEnabledAfterVerification: boolean;
}

export interface WorkersCoordinatorPublisherTaxProductionCutoverReadinessEvidence {
  readonly source: 'publisher-tax-filing-production-cutover-readiness';
  readonly capturedAtMs: number;
  readonly sandboxProviderFilingIds: readonly string[];
  readonly operatorApprovalEvidence: WorkersCoordinatorPublisherTaxProductionCutoverOperatorApproval;
  readonly productionFilingWindow: WorkersCoordinatorPublisherTaxProductionFilingWindow;
  readonly liveProviderPreflightEvidence: readonly WorkersCoordinatorPublisherTaxLiveProviderPreflight[];
  readonly preservedSandboxEvidence: WorkersCoordinatorPublisherTaxProductionCutoverPreservedSandboxEvidence;
  readonly emergencyReadiness: WorkersCoordinatorPublisherTaxProductionCutoverEmergencyReadiness;
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxProductionCutoverReadinessOptions {
  readonly sandboxFilingReport: WorkersCoordinatorPublisherTaxProviderSandboxFilingReport;
  readonly productionCutoverEvidence: WorkersCoordinatorPublisherTaxProductionCutoverReadinessEvidence;
}

export interface WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport {
  readonly runtime: 'publisher-tax-filing-production-cutover-readiness-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly sandboxProviderFilingIds: readonly string[];
  readonly operatorApprovalEvidence: WorkersCoordinatorPublisherTaxProductionCutoverOperatorApproval;
  readonly productionFilingWindow: WorkersCoordinatorPublisherTaxProductionFilingWindow;
  readonly liveProviderPreflightEvidence: readonly WorkersCoordinatorPublisherTaxLiveProviderPreflight[];
  readonly preservedSandboxEvidence: WorkersCoordinatorPublisherTaxProductionCutoverPreservedSandboxEvidence;
  readonly productionCutoverSummary: {
    readonly sandboxProviderFilingIdCount: number;
    readonly approvedSandboxProviderFilingIdCount: number;
    readonly liveProviderPreflightCount: number;
    readonly duplicateFilingSuppressionCount: number;
    readonly rollbackControlCount: number;
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringProductionCutover: {
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

export function runWorkersCoordinatorPublisherTaxProductionCutoverReadinessGate(
  options: WorkersCoordinatorPublisherTaxProductionCutoverReadinessOptions,
): WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.productionCutoverEvidence);
  const productionCutoverSummary = summarizeProductionCutover(options.productionCutoverEvidence);
  const holdReasons = selectHoldReasons({
    ...options,
    productionCutoverSummary,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-tax-filing-production-cutover-readiness-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.sandboxFilingReport.previewRunnerUrl,
    sandboxProviderFilingIds: options.productionCutoverEvidence.sandboxProviderFilingIds,
    operatorApprovalEvidence: options.productionCutoverEvidence.operatorApprovalEvidence,
    productionFilingWindow: options.productionCutoverEvidence.productionFilingWindow,
    liveProviderPreflightEvidence: options.productionCutoverEvidence.liveProviderPreflightEvidence,
    preservedSandboxEvidence: options.productionCutoverEvidence.preservedSandboxEvidence,
    productionCutoverSummary,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher tax provider sandbox filing gate has already passed',
        'operator approval maps sandbox provider filing IDs into one production preflight window',
        'live-provider production endpoint preflight does not move money or submit duplicate filings',
        'accepted and rejected sandbox run evidence remains linked through retry, delivery, corrected-form, and audit records',
        'rollback and emergency hold controls are verified before production callbacks are enabled',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact during production cutover readiness',
      ],
      holdReasons,
    },
    securityBoundaryDuringProductionCutover: {
      cspConnectSrc: options.productionCutoverEvidence.cspConnectSrc,
      sandboxFlags: options.productionCutoverEvidence.sandboxFlags,
      coop: options.productionCutoverEvidence.coop,
      coep: options.productionCutoverEvidence.coep,
      allowedOrigins: options.productionCutoverEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherTaxProductionCutoverReadinessOptions & {
  readonly productionCutoverSummary: WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport['productionCutoverSummary'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.sandboxFilingReport.status === 'fail') {
    return [`publisher-tax-provider-sandbox-filing-gate-not-clean: ${input.sandboxFilingReport.failureReason ?? 'unknown'}`];
  }
  if (input.productionCutoverEvidence.source !== 'publisher-tax-filing-production-cutover-readiness') {
    return ['publisher-tax-production-cutover-readiness-must-use-production-cutover-evidence'];
  }

  const holdReasons: string[] = [];
  const sandboxProviderFilingIds = new Set(input.sandboxFilingReport.sandboxRuns.map((run) =>
    run.submission.providerFilingId,
  ));
  const acceptedProviderFilingIds = new Set(input.sandboxFilingReport.sandboxRuns
    .filter((run) => run.submission.status === 'accepted')
    .map((run) => run.submission.providerFilingId));
  const rejectedProviderFilingIds = new Set(input.sandboxFilingReport.sandboxRuns
    .filter((run) => run.submission.status === 'rejected')
    .map((run) => run.submission.providerFilingId));
  const retryEvidenceIds = new Set(input.sandboxFilingReport.sandboxRuns.flatMap((run) => run.retryEvidenceIds));
  const publisherDeliveryIds = new Set(input.sandboxFilingReport.sandboxReconciliations.flatMap((reconciliation) =>
    reconciliation.publisherDeliveryIds,
  ));
  const correctedFormWorkflowIds = new Set(input.sandboxFilingReport.sandboxReconciliations.flatMap((reconciliation) =>
    reconciliation.correctedFormWorkflowIds,
  ));
  const postFilingAuditIds = new Set(input.sandboxFilingReport.sandboxReconciliations.flatMap((reconciliation) =>
    reconciliation.postFilingAuditIds,
  ));
  const emergencyControlIds = new Set(input.sandboxFilingReport.sandboxReconciliations.flatMap((reconciliation) =>
    reconciliation.emergencyControlIds,
  ));

  const approval = input.productionCutoverEvidence.operatorApprovalEvidence;
  const window = input.productionCutoverEvidence.productionFilingWindow;
  if (approval.approvalId.length === 0 ||
    approval.operatorId.length === 0 ||
    !isPositiveFinite(approval.approvedAtMs) ||
    approval.productionWindowId !== window.windowId ||
    approval.approvedSandboxProviderFilingIds.length === 0 ||
    approval.approvedSandboxProviderFilingIds.some((filingId) => !sandboxProviderFilingIds.has(filingId)) ||
    approval.duplicateFilingSuppressionIds.length === 0 ||
    approval.rollbackPlanId.length === 0 ||
    approval.emergencyHoldSwitchId.length === 0
  ) {
    holdReasons.push(`publisher-tax-production-cutover-operator-approval-invalid: ${approval.approvalId || 'unknown'}`);
  }

  if (input.productionCutoverEvidence.sandboxProviderFilingIds.length === 0 ||
    input.productionCutoverEvidence.sandboxProviderFilingIds.some((filingId) => !sandboxProviderFilingIds.has(filingId)) ||
    approval.approvedSandboxProviderFilingIds.some((filingId) =>
      !input.productionCutoverEvidence.sandboxProviderFilingIds.includes(filingId),
    )
  ) {
    holdReasons.push('publisher-tax-production-cutover-sandbox-provider-filing-ids-not-linked');
  }

  if (window.windowId.length === 0 ||
    window.environment !== 'production' ||
    window.filingMode !== 'preflight-only' ||
    !isPositiveFinite(window.opensAtMs) ||
    !isPositiveFinite(window.closesAtMs) ||
    !isPositiveFinite(window.callbackEnableAtMs) ||
    window.closesAtMs <= window.opensAtMs ||
    window.callbackEnableAtMs < window.closesAtMs ||
    window.duplicateFilingSuppressionIds.length === 0 ||
    window.duplicateFilingSuppressionIds.some((suppressionId) =>
      !approval.duplicateFilingSuppressionIds.includes(suppressionId),
    ) ||
    !window.liveMoneyMovementSuppressed ||
    window.productionCallbacksEnabled
  ) {
    holdReasons.push(`publisher-tax-production-cutover-window-invalid: ${window.windowId || 'unknown'}`);
  }

  const invalidPreflight = input.productionCutoverEvidence.liveProviderPreflightEvidence.find((preflight) =>
    preflight.preflightId.length === 0 ||
    preflight.provider !== window.provider ||
    preflight.endpointMode !== 'production-preflight' ||
    preflight.providerAccountId.length === 0 ||
    !isPositiveFinite(preflight.checkedAtMs) ||
    preflight.checkedAtMs < window.opensAtMs ||
    preflight.checkedAtMs > window.closesAtMs ||
    !preflight.dryRun ||
    preflight.wouldSubmitFiling ||
    !preflight.duplicateFilingSuppressed ||
    preflight.providerTraceId.length === 0
  );
  if (invalidPreflight || input.productionCutoverEvidence.liveProviderPreflightEvidence.length === 0) {
    holdReasons.push(`publisher-tax-production-cutover-live-provider-preflight-invalid: ${invalidPreflight?.preflightId ?? 'missing'}`);
  }

  const preserved = input.productionCutoverEvidence.preservedSandboxEvidence;
  if (preserved.acceptedProviderFilingIds.length === 0 ||
    preserved.acceptedProviderFilingIds.some((filingId) => !acceptedProviderFilingIds.has(filingId)) ||
    preserved.rejectedProviderFilingIds.length === 0 ||
    preserved.rejectedProviderFilingIds.some((filingId) => !rejectedProviderFilingIds.has(filingId)) ||
    preserved.retryEvidenceIds.length === 0 ||
    preserved.retryEvidenceIds.some((retryId) => !retryEvidenceIds.has(retryId)) ||
    preserved.publisherDeliveryIds.length === 0 ||
    preserved.publisherDeliveryIds.some((deliveryId) => !publisherDeliveryIds.has(deliveryId)) ||
    preserved.correctedFormWorkflowIds.length === 0 ||
    preserved.correctedFormWorkflowIds.some((workflowId) => !correctedFormWorkflowIds.has(workflowId)) ||
    preserved.postFilingAuditIds.length === 0 ||
    preserved.postFilingAuditIds.some((auditId) => !postFilingAuditIds.has(auditId))
  ) {
    holdReasons.push('publisher-tax-production-cutover-preserved-sandbox-evidence-invalid');
  }

  const emergency = input.productionCutoverEvidence.emergencyReadiness;
  if (emergency.emergencyControlIds.length === 0 ||
    emergency.emergencyControlIds.some((controlId) => !emergencyControlIds.has(controlId)) ||
    !emergency.rollbackPlanIds.includes(approval.rollbackPlanId) ||
    !emergency.emergencyHoldSwitchIds.includes(approval.emergencyHoldSwitchId) ||
    !isPositiveFinite(emergency.verifiedAtMs) ||
    emergency.verifiedAtMs < approval.approvedAtMs ||
    emergency.productionCallbacksEnabledAfterVerification
  ) {
    holdReasons.push('publisher-tax-production-cutover-emergency-readiness-invalid');
  }

  const leakedNetworkAttempt = input.productionCutoverEvidence.networkAttempts.find((attempt) =>
    !input.productionCutoverEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-tax-production-cutover-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-tax-production-cutover-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.productionCutoverEvidence.allowedOrigins.every((origin) => input.productionCutoverEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-tax-production-cutover-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.productionCutoverEvidence.sandboxFlags.length === 1 && input.productionCutoverEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-tax-production-cutover-sandbox-must-remain-allow-scripts-only');
  }
  if (input.productionCutoverEvidence.coop !== 'same-origin' || input.productionCutoverEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-tax-production-cutover-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function summarizeProductionCutover(
  evidence: WorkersCoordinatorPublisherTaxProductionCutoverReadinessEvidence,
): WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport['productionCutoverSummary'] {
  return {
    sandboxProviderFilingIdCount: evidence.sandboxProviderFilingIds.length,
    approvedSandboxProviderFilingIdCount: evidence.operatorApprovalEvidence.approvedSandboxProviderFilingIds.length,
    liveProviderPreflightCount: evidence.liveProviderPreflightEvidence.length,
    duplicateFilingSuppressionCount: evidence.productionFilingWindow.duplicateFilingSuppressionIds.length,
    rollbackControlCount: evidence.emergencyReadiness.rollbackPlanIds.length +
      evidence.emergencyReadiness.emergencyHoldSwitchIds.length,
  };
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherTaxProductionCutoverReadinessEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('operator-approval') || failureReason?.includes('window-invalid')) {
    return ['publisher-tax-production-cutover-operator-window-hardening'];
  }
  if (failureReason?.includes('preflight') || failureReason?.includes('duplicate')) {
    return ['publisher-tax-production-cutover-live-provider-preflight-hardening'];
  }
  if (failureReason?.includes('emergency') || failureReason?.includes('rollback')) {
    return ['publisher-tax-production-cutover-rollback-hold-hardening'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-tax-production-cutover-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-tax-production-cutover-readiness-failure: ${failureReason}`];
  }
  return ['publisher-tax-filing-production-callbacks-readiness'];
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
