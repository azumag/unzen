import type { WorkersCoordinatorRunnerNetworkAttempt } from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport,
  WorkersCoordinatorPublisherTaxProductionRunbookActionRecord,
} from './workers-coordinator-publisher-tax-production-exception-operations.js';

export type WorkersCoordinatorPublisherTaxProductionResolutionOutcome =
  | 'resolved'
  | 'carried-forward';

export interface WorkersCoordinatorPublisherTaxProductionCarryForward {
  readonly ownerId: string;
  readonly reason: string;
  readonly nextReviewAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionActionResolution {
  readonly resolutionId: string;
  readonly actionId: string;
  readonly outcome: WorkersCoordinatorPublisherTaxProductionResolutionOutcome;
  readonly resolvedAtMs?: number;
  readonly carryForward?: WorkersCoordinatorPublisherTaxProductionCarryForward;
}

export interface WorkersCoordinatorPublisherTaxProductionProviderCorrectionOutcome {
  readonly correctionOutcomeId: string;
  readonly actionId: string;
  readonly providerFilingId: string;
  readonly productionWindowId: string;
  readonly providerSubmissionId: string;
  readonly providerStatus: 'accepted' | 'rejected';
  readonly observedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionSupportResolution {
  readonly supportEscalationId: string;
  readonly actionId: string;
  readonly state: 'closed' | 'carried-forward';
  readonly closedAtMs?: number;
  readonly nextReviewAtMs?: number;
}

export interface WorkersCoordinatorPublisherTaxProductionTerminalPublisherStatus {
  readonly terminalStatusUpdateId: string;
  readonly providerFilingId: string;
  readonly productionWindowId: string;
  readonly actionIds: readonly string[];
  readonly status:
    | 'resolved'
    | 'corrected-accepted'
    | 'duplicate-confirmed'
    | 'replay-cleared'
    | 'carried-forward';
  readonly publishedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionImmutableIdentityAudit {
  readonly auditRecordId: string;
  readonly actionId: string;
  readonly supportEscalationIds: readonly string[];
  readonly originalPublisherStatusUpdateIds: readonly string[];
  readonly identityFingerprint: string;
  readonly recordedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditEvidence {
  readonly source: 'publisher-tax-filing-production-exception-resolution-audit';
  readonly capturedAtMs: number;
  readonly actionResolutions: readonly WorkersCoordinatorPublisherTaxProductionActionResolution[];
  readonly providerCorrectionOutcomes: readonly WorkersCoordinatorPublisherTaxProductionProviderCorrectionOutcome[];
  readonly supportResolutions: readonly WorkersCoordinatorPublisherTaxProductionSupportResolution[];
  readonly terminalPublisherStatuses: readonly WorkersCoordinatorPublisherTaxProductionTerminalPublisherStatus[];
  readonly immutableIdentityAudits: readonly WorkersCoordinatorPublisherTaxProductionImmutableIdentityAudit[];
  readonly preservedDuplicateFilingSuppressionIds: readonly string[];
  readonly rollbackEmergencyDecisionIdentity: {
    readonly decisionId: string;
    readonly rollbackPlanId: string;
    readonly emergencyHoldSwitchId: string;
  };
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditOptions {
  readonly exceptionOperationsReport: WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport;
  readonly resolutionAuditEvidence: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditEvidence;
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport {
  readonly runtime: 'publisher-tax-filing-production-exception-resolution-audit-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly exceptionOperationsEvidence: WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport;
  readonly actionResolutions: readonly WorkersCoordinatorPublisherTaxProductionActionResolution[];
  readonly providerCorrectionOutcomes: readonly WorkersCoordinatorPublisherTaxProductionProviderCorrectionOutcome[];
  readonly supportResolutions: readonly WorkersCoordinatorPublisherTaxProductionSupportResolution[];
  readonly terminalPublisherStatuses: readonly WorkersCoordinatorPublisherTaxProductionTerminalPublisherStatus[];
  readonly immutableIdentityAudits: readonly WorkersCoordinatorPublisherTaxProductionImmutableIdentityAudit[];
  readonly resolutionSummary: {
    readonly upstreamActionCount: number;
    readonly resolvedActionCount: number;
    readonly carriedForwardActionCount: number;
    readonly correctionOutcomeCount: number;
    readonly closedSupportEscalationCount: number;
    readonly carriedForwardSupportEscalationCount: number;
    readonly terminalPublisherStatusCount: number;
  };
  readonly duplicateFilingSuppressionState: {
    readonly requiredDuplicateFilingSuppressionIds: readonly string[];
    readonly preservedDuplicateFilingSuppressionIds: readonly string[];
  };
  readonly rollbackEmergencyDecisionIdentity: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditEvidence['rollbackEmergencyDecisionIdentity'];
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringResolutionAudit: {
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

export function runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate(
  options: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditOptions,
): WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport {
  const upstream = options.exceptionOperationsReport;
  const evidence = options.resolutionAuditEvidence;
  const duplicateFilingSuppressionState = {
    requiredDuplicateFilingSuppressionIds:
      upstream.duplicateFilingSuppressionState.requiredDuplicateFilingSuppressionIds,
    preservedDuplicateFilingSuppressionIds: evidence.preservedDuplicateFilingSuppressionIds,
  };
  const blockedNonCoordinatorCdnNetworkAttempt = selectBlockedNonCoordinatorCdnNetworkAttempt(evidence);
  const holdReasons = selectHoldReasons({
    ...options,
    duplicateFilingSuppressionState,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-tax-filing-production-exception-resolution-audit-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: upstream.previewRunnerUrl,
    exceptionOperationsEvidence: upstream,
    actionResolutions: evidence.actionResolutions,
    providerCorrectionOutcomes: evidence.providerCorrectionOutcomes,
    supportResolutions: evidence.supportResolutions,
    terminalPublisherStatuses: evidence.terminalPublisherStatuses,
    immutableIdentityAudits: evidence.immutableIdentityAudits,
    resolutionSummary: {
      upstreamActionCount: upstream.operatorRunbookActions.length,
      resolvedActionCount: evidence.actionResolutions.filter((entry) => entry.outcome === 'resolved').length,
      carriedForwardActionCount: evidence.actionResolutions.filter((entry) => entry.outcome === 'carried-forward').length,
      correctionOutcomeCount: evidence.providerCorrectionOutcomes.length,
      closedSupportEscalationCount: evidence.supportResolutions.filter((entry) => entry.state === 'closed').length,
      carriedForwardSupportEscalationCount: evidence.supportResolutions.filter((entry) => entry.state === 'carried-forward').length,
      terminalPublisherStatusCount: evidence.terminalPublisherStatuses.length,
    },
    duplicateFilingSuppressionState,
    rollbackEmergencyDecisionIdentity: evidence.rollbackEmergencyDecisionIdentity,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'production exception operations runbook gate has already passed',
        'every upstream runbook action has exactly one terminal resolution or explicit carry-forward record',
        'corrected filing actions reconcile to provider correction outcome evidence in the approved production window',
        'support escalation resolution state matches the action resolution state',
        'publisher-facing status is terminal for resolved actions and explicitly carried-forward otherwise',
        'immutable identity audit records preserve original runbook, support escalation, and publisher status identities',
        'duplicate-filing suppression and rollback/emergency-hold control identities remain unchanged',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact during resolution audit',
      ],
      holdReasons,
    },
    securityBoundaryDuringResolutionAudit: {
      cspConnectSrc: evidence.cspConnectSrc,
      sandboxFlags: evidence.sandboxFlags,
      coop: evidence.coop,
      coep: evidence.coep,
      allowedOrigins: evidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(
  input: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditOptions & {
    readonly duplicateFilingSuppressionState: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport['duplicateFilingSuppressionState'];
    readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
  },
): readonly string[] {
  const upstream = input.exceptionOperationsReport;
  const evidence = input.resolutionAuditEvidence;
  if (upstream.status === 'fail') {
    return [`publisher-tax-production-exception-operations-gate-not-clean: ${upstream.failureReason ?? 'unknown'}`];
  }
  if (evidence.source !== 'publisher-tax-filing-production-exception-resolution-audit') {
    return ['publisher-tax-production-exception-resolution-must-use-audit-evidence'];
  }

  const holdReasons: string[] = [];
  const latestUpstreamAtMs = Math.max(
    ...upstream.operatorRunbookActions.map((entry) => entry.createdAtMs),
    ...upstream.publisherStatusUpdates.map((entry) => entry.publishedAtMs),
    upstream.rollbackEmergencyDecisionEvidence.decidedAtMs,
    0,
  );
  if (evidence.capturedAtMs < latestUpstreamAtMs) {
    holdReasons.push('publisher-tax-production-exception-resolution-captured-before-runbook-complete');
  }

  const upstreamActionIds = new Set(upstream.operatorRunbookActions.map((entry) => entry.actionId));
  const resolutionActionIds = evidence.actionResolutions.map((entry) => entry.actionId);
  if (
    resolutionActionIds.length !== upstreamActionIds.size ||
    new Set(resolutionActionIds).size !== resolutionActionIds.length ||
    resolutionActionIds.some((actionId) => !upstreamActionIds.has(actionId))
  ) {
    holdReasons.push('publisher-tax-production-exception-resolution-action-coverage-invalid');
  }

  for (const action of upstream.operatorRunbookActions) {
    validateActionResolution(action, upstream, evidence, holdReasons);
  }

  const requiredSuppressionIds = input.duplicateFilingSuppressionState.requiredDuplicateFilingSuppressionIds;
  if (!sameSet(requiredSuppressionIds, input.duplicateFilingSuppressionState.preservedDuplicateFilingSuppressionIds)) {
    holdReasons.push('publisher-tax-production-exception-resolution-duplicate-suppression-changed');
  }

  const upstreamDecision = upstream.rollbackEmergencyDecisionEvidence;
  if (
    evidence.rollbackEmergencyDecisionIdentity.decisionId !== upstreamDecision.decisionId ||
    evidence.rollbackEmergencyDecisionIdentity.rollbackPlanId !== upstreamDecision.rollbackPlanId ||
    evidence.rollbackEmergencyDecisionIdentity.emergencyHoldSwitchId !== upstreamDecision.emergencyHoldSwitchId
  ) {
    holdReasons.push('publisher-tax-production-exception-resolution-rollback-hold-identity-changed');
  }

  const leakedNetworkAttempt = evidence.networkAttempts.find(
    (attempt) => !evidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(
      `publisher-tax-production-exception-resolution-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`,
    );
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-tax-production-exception-resolution-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!evidence.allowedOrigins.every((origin) => evidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-tax-production-exception-resolution-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(evidence.sandboxFlags.length === 1 && evidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-tax-production-exception-resolution-sandbox-must-remain-allow-scripts-only');
  }
  if (evidence.coop !== 'same-origin' || evidence.coep !== 'require-corp') {
    holdReasons.push('publisher-tax-production-exception-resolution-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function validateActionResolution(
  action: WorkersCoordinatorPublisherTaxProductionRunbookActionRecord,
  upstream: WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport,
  evidence: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditEvidence,
  holdReasons: string[],
): void {
  const resolutions = evidence.actionResolutions.filter((entry) => entry.actionId === action.actionId);
  if (resolutions.length !== 1) {
    holdReasons.push(`publisher-tax-production-exception-resolution-missing-or-duplicate: ${action.actionId}`);
    return;
  }
  const resolution = resolutions[0]!;
  if (!resolution.resolutionId || !isPositiveFinite(evidence.capturedAtMs)) {
    holdReasons.push(`publisher-tax-production-exception-resolution-invalid: ${action.actionId}`);
    return;
  }

  if (resolution.outcome === 'resolved') {
    if (!isPositiveFinite(resolution.resolvedAtMs) || resolution.resolvedAtMs! > evidence.capturedAtMs || resolution.carryForward !== undefined) {
      holdReasons.push(`publisher-tax-production-exception-resolution-terminal-invalid: ${action.actionId}`);
    }
  } else {
    const carry = resolution.carryForward;
    if (
      resolution.resolvedAtMs !== undefined ||
      !carry ||
      !carry.ownerId ||
      !carry.reason ||
      !isPositiveFinite(carry.nextReviewAtMs) ||
      carry.nextReviewAtMs <= evidence.capturedAtMs
    ) {
      holdReasons.push(`publisher-tax-production-exception-resolution-carry-forward-invalid: ${action.actionId}`);
    }
  }

  if (action.action === 'prepare-correction') {
    const providerOutcomes = evidence.providerCorrectionOutcomes.filter((entry) => entry.actionId === action.actionId);
    if (
      providerOutcomes.length !== 1 ||
      !action.providerFilingIds.includes(providerOutcomes[0]!.providerFilingId) ||
      providerOutcomes[0]!.productionWindowId !== action.productionWindowId ||
      !providerOutcomes[0]!.correctionOutcomeId ||
      !providerOutcomes[0]!.providerSubmissionId ||
      !isPositiveFinite(providerOutcomes[0]!.observedAtMs) ||
      providerOutcomes[0]!.observedAtMs > evidence.capturedAtMs
    ) {
      holdReasons.push(`publisher-tax-production-exception-resolution-correction-outcome-invalid: ${action.actionId}`);
    }
  }

  const upstreamEscalations = upstream.supportEscalations.filter((entry) => entry.actionId === action.actionId);
  const supportResolutions = evidence.supportResolutions.filter((entry) => entry.actionId === action.actionId);
  if (
    supportResolutions.length !== upstreamEscalations.length ||
    supportResolutions.some((entry) => !upstreamEscalations.some((upstreamEntry) => upstreamEntry.supportEscalationId === entry.supportEscalationId))
  ) {
    holdReasons.push(`publisher-tax-production-exception-resolution-support-coverage-invalid: ${action.actionId}`);
  } else {
    for (const support of supportResolutions) {
      if (resolution.outcome === 'resolved') {
        if (support.state !== 'closed' || !isPositiveFinite(support.closedAtMs) || support.closedAtMs! > evidence.capturedAtMs || support.nextReviewAtMs !== undefined) {
          holdReasons.push(`publisher-tax-production-exception-resolution-support-state-invalid: ${action.actionId}`);
        }
      } else if (
        support.state !== 'carried-forward' ||
        support.closedAtMs !== undefined ||
        !isPositiveFinite(support.nextReviewAtMs) ||
        support.nextReviewAtMs! <= evidence.capturedAtMs
      ) {
        holdReasons.push(`publisher-tax-production-exception-resolution-support-state-invalid: ${action.actionId}`);
      }
    }
  }

  const providerFilingIds = action.providerFilingIds;
  for (const providerFilingId of providerFilingIds) {
    const terminalStatuses = evidence.terminalPublisherStatuses.filter(
      (entry) =>
        entry.providerFilingId === providerFilingId &&
        entry.productionWindowId === action.productionWindowId &&
        entry.actionIds.includes(action.actionId),
    );
    if (terminalStatuses.length !== 1 || !isPositiveFinite(terminalStatuses[0]!.publishedAtMs) || terminalStatuses[0]!.publishedAtMs > evidence.capturedAtMs) {
      holdReasons.push(`publisher-tax-production-exception-resolution-publisher-status-invalid: ${action.actionId}`);
      continue;
    }
    if (resolution.outcome === 'resolved' && terminalStatuses[0]!.status === 'carried-forward') {
      holdReasons.push(`publisher-tax-production-exception-resolution-publisher-status-not-terminal: ${action.actionId}`);
    }
    if (resolution.outcome === 'carried-forward' && terminalStatuses[0]!.status !== 'carried-forward') {
      holdReasons.push(`publisher-tax-production-exception-resolution-publisher-status-not-carried-forward: ${action.actionId}`);
    }
  }

  const identityAudits = evidence.immutableIdentityAudits.filter((entry) => entry.actionId === action.actionId);
  const expectedSupportIds = upstreamEscalations.map((entry) => entry.supportEscalationId);
  const expectedPublisherStatusIds = upstream.publisherStatusUpdates
    .filter((entry) => entry.actionIds.includes(action.actionId))
    .map((entry) => entry.statusUpdateId);
  if (
    identityAudits.length !== 1 ||
    !identityAudits[0]!.auditRecordId ||
    !isPositiveFinite(identityAudits[0]!.recordedAtMs) ||
    identityAudits[0]!.recordedAtMs > evidence.capturedAtMs ||
    !sameSet(identityAudits[0]!.supportEscalationIds, expectedSupportIds) ||
    !sameSet(identityAudits[0]!.originalPublisherStatusUpdateIds, expectedPublisherStatusIds) ||
    identityAudits[0]!.identityFingerprint !== identityFingerprint(action.actionId, expectedSupportIds, expectedPublisherStatusIds)
  ) {
    holdReasons.push(`publisher-tax-production-exception-resolution-immutable-identity-invalid: ${action.actionId}`);
  }
}

export function createWorkersCoordinatorPublisherTaxProductionExceptionIdentityFingerprint(
  actionId: string,
  supportEscalationIds: readonly string[],
  publisherStatusUpdateIds: readonly string[],
): string {
  return identityFingerprint(actionId, supportEscalationIds, publisherStatusUpdateIds);
}

function identityFingerprint(
  actionId: string,
  supportEscalationIds: readonly string[],
  publisherStatusUpdateIds: readonly string[],
): string {
  return [
    `action=${actionId}`,
    `support=${[...supportEscalationIds].sort().join(',')}`,
    `publisher=${[...publisherStatusUpdateIds].sort().join(',')}`,
  ].join('|');
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find(
    (attempt) => !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('correction-outcome')) {
    return ['publisher-tax-production-exception-correction-resolution-hardening'];
  }
  if (failureReason?.includes('support')) {
    return ['publisher-tax-production-exception-support-resolution-hardening'];
  }
  if (failureReason?.includes('publisher-status')) {
    return ['publisher-tax-production-exception-publisher-status-resolution-hardening'];
  }
  if (failureReason?.includes('immutable-identity')) {
    return ['publisher-tax-production-exception-audit-identity-hardening'];
  }
  if (failureReason?.includes('duplicate-suppression') || failureReason?.includes('rollback-hold')) {
    return ['publisher-tax-production-exception-resolution-control-integrity-hardening'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-tax-production-exception-resolution-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-tax-production-exception-resolution-audit-failure: ${failureReason}`];
  }
  return ['publisher-tax-filing-production-exception-audit-archive-retention'];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
