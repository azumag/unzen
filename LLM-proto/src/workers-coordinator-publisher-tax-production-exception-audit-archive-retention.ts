import type { WorkersCoordinatorRunnerNetworkAttempt } from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport,
} from './workers-coordinator-publisher-tax-production-exception-resolution-audit.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_SCHEMA_VERSION = '1.0.0' as const;

export interface WorkersCoordinatorPublisherTaxProductionExceptionArchiveIdentity {
  readonly actionResolutionIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly providerCorrectionOutcomeIds: readonly string[];
  readonly supportEscalationIds: readonly string[];
  readonly terminalPublisherStatusUpdateIds: readonly string[];
  readonly immutableIdentityAuditRecordIds: readonly string[];
  readonly identityFingerprints: readonly string[];
  readonly providerFilingIds: readonly string[];
  readonly productionCallbackIds: readonly string[];
  readonly replayIds: readonly string[];
  readonly duplicateFilingSuppressionIds: readonly string[];
  readonly rollbackEmergencyDecisionIdentity: {
    readonly decisionId: string;
    readonly rollbackPlanId: string;
    readonly emergencyHoldSwitchId: string;
  };
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage {
  readonly schemaVersion: typeof PUBLISHER_TAX_EXCEPTION_ARCHIVE_SCHEMA_VERSION;
  readonly archiveId: string;
  readonly createdAtMs: number;
  readonly identity: WorkersCoordinatorPublisherTaxProductionExceptionArchiveIdentity;
  readonly contentDigest: string;
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionArchiveExportEvidence {
  readonly archiveId: string;
  readonly archiveLocator: string;
  readonly storageClass: 'immutable-object' | 'compliance-archive';
  readonly retentionPolicyId: string;
  readonly exportedAtMs: number;
  readonly contentDigest: string;
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionRetentionPolicyEvidence {
  readonly policyId: string;
  readonly minimumRetentionMs: number;
  readonly retentionStartsAtMs: number;
  readonly retentionEndsAtMs: number;
  readonly legalHold: boolean;
  readonly operationalHold: boolean;
  readonly deletionEligible: boolean;
  readonly deletionReview: {
    readonly reviewId: string;
    readonly decision: 'retain' | 'eligible-after-retention';
    readonly reason: string;
    readonly reviewedAtMs: number;
    readonly nextReviewAtMs?: number;
  };
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetrievalProof {
  readonly retrievalProofId: string;
  readonly archiveId: string;
  readonly lookupKind: 'archive-id' | 'provider-filing-id';
  readonly lookupValue: string;
  readonly retrievedAtMs: number;
  readonly contentDigest: string;
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionEvidence {
  readonly source: 'publisher-tax-filing-production-exception-audit-archive-retention';
  readonly capturedAtMs: number;
  readonly archivePackage: WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage;
  readonly archiveExport: WorkersCoordinatorPublisherTaxProductionExceptionArchiveExportEvidence;
  readonly retentionPolicy: WorkersCoordinatorPublisherTaxProductionExceptionRetentionPolicyEvidence;
  readonly retrievalProofs: readonly WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetrievalProof[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionOptions {
  readonly resolutionAuditReport: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport;
  readonly archiveRetentionEvidence: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionEvidence;
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport {
  readonly runtime: 'publisher-tax-filing-production-exception-audit-archive-retention-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly resolutionAuditEvidence: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport;
  readonly archivePackage: WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage;
  readonly archiveExport: WorkersCoordinatorPublisherTaxProductionExceptionArchiveExportEvidence;
  readonly retentionPolicy: WorkersCoordinatorPublisherTaxProductionExceptionRetentionPolicyEvidence;
  readonly retrievalProofs: readonly WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetrievalProof[];
  readonly archiveSummary: {
    readonly affectedProviderFilingCount: number;
    readonly resolutionCount: number;
    readonly carriedForwardCount: number;
    readonly retrievalProofCount: number;
    readonly retentionDurationMs: number;
    readonly deletionEligible: boolean;
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringArchiveVerification: {
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

export function buildWorkersCoordinatorPublisherTaxProductionExceptionArchiveIdentity(
  report: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport,
): WorkersCoordinatorPublisherTaxProductionExceptionArchiveIdentity {
  const runbookActions = report.exceptionOperationsEvidence.operatorRunbookActions;
  return {
    actionResolutionIds: sortedUnique(report.actionResolutions.map((entry) => entry.resolutionId)),
    actionIds: sortedUnique(runbookActions.map((entry) => entry.actionId)),
    providerCorrectionOutcomeIds: sortedUnique(
      report.providerCorrectionOutcomes.map((entry) => entry.correctionOutcomeId),
    ),
    supportEscalationIds: sortedUnique(
      report.supportResolutions.map((entry) => entry.supportEscalationId),
    ),
    terminalPublisherStatusUpdateIds: sortedUnique(
      report.terminalPublisherStatuses.map((entry) => entry.terminalStatusUpdateId),
    ),
    immutableIdentityAuditRecordIds: sortedUnique(
      report.immutableIdentityAudits.map((entry) => entry.auditRecordId),
    ),
    identityFingerprints: sortedUnique(
      report.immutableIdentityAudits.map((entry) => entry.identityFingerprint),
    ),
    providerFilingIds: sortedUnique(runbookActions.flatMap((entry) => entry.providerFilingIds)),
    productionCallbackIds: sortedUnique(
      runbookActions.flatMap((entry) => entry.callbackId ? [entry.callbackId] : []),
    ),
    replayIds: sortedUnique(runbookActions.flatMap((entry) => entry.replayId ? [entry.replayId] : [])),
    duplicateFilingSuppressionIds: sortedUnique(
      report.duplicateFilingSuppressionState.preservedDuplicateFilingSuppressionIds,
    ),
    rollbackEmergencyDecisionIdentity: {
      ...report.rollbackEmergencyDecisionIdentity,
    },
  };
}

export async function createWorkersCoordinatorPublisherTaxProductionExceptionArchivePackage(
  report: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport,
  input: { readonly archiveId: string; readonly createdAtMs: number },
): Promise<WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage> {
  const identity = buildWorkersCoordinatorPublisherTaxProductionExceptionArchiveIdentity(report);
  const unsigned = {
    schemaVersion: PUBLISHER_TAX_EXCEPTION_ARCHIVE_SCHEMA_VERSION,
    archiveId: input.archiveId,
    createdAtMs: input.createdAtMs,
    identity,
  } as const;
  return {
    ...unsigned,
    contentDigest: await computeWorkersCoordinatorPublisherTaxProductionExceptionArchiveDigest(unsigned),
  };
}

export async function computeWorkersCoordinatorPublisherTaxProductionExceptionArchiveDigest(
  value: Omit<WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage, 'contentDigest'>,
): Promise<string> {
  const canonical = canonicalArchivePackage(value);
  const encoded = new TextEncoder().encode(canonical);
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate(
  options: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionOptions,
): Promise<WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport> {
  const upstream = options.resolutionAuditReport;
  const evidence = options.archiveRetentionEvidence;
  const blockedNonCoordinatorCdnNetworkAttempt = selectBlockedNonCoordinatorCdnNetworkAttempt(evidence);
  const holdReasons = await selectHoldReasons(options, blockedNonCoordinatorCdnNetworkAttempt);
  const failureReason = holdReasons[0];
  const affectedProviderFilingIds = buildWorkersCoordinatorPublisherTaxProductionExceptionArchiveIdentity(upstream)
    .providerFilingIds;

  return {
    runtime: 'publisher-tax-filing-production-exception-audit-archive-retention-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: upstream.previewRunnerUrl,
    resolutionAuditEvidence: upstream,
    archivePackage: evidence.archivePackage,
    archiveExport: evidence.archiveExport,
    retentionPolicy: evidence.retentionPolicy,
    retrievalProofs: evidence.retrievalProofs,
    archiveSummary: {
      affectedProviderFilingCount: affectedProviderFilingIds.length,
      resolutionCount: upstream.actionResolutions.length,
      carriedForwardCount: upstream.actionResolutions.filter((entry) => entry.outcome === 'carried-forward').length,
      retrievalProofCount: evidence.retrievalProofs.length,
      retentionDurationMs: evidence.retentionPolicy.retentionEndsAtMs - evidence.retentionPolicy.retentionStartsAtMs,
      deletionEligible: evidence.retentionPolicy.deletionEligible,
    },
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'production exception resolution audit gate has already passed',
        'one stable versioned archive package exactly preserves the upstream resolution audit identity set',
        'archive package, export evidence, and retrieval proofs agree on the SHA-256 content digest',
        'the archive is retrievable by archive ID and every affected provider filing ID',
        'retention duration meets the policy minimum and extends beyond carried-forward review obligations',
        'legal or operational hold always disables deletion eligibility',
        'deletion eligibility is represented only by an explicit auditable review record and this gate never performs deletion',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact during archive verification',
      ],
      holdReasons,
    },
    securityBoundaryDuringArchiveVerification: {
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

async function selectHoldReasons(
  options: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionOptions,
  blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null,
): Promise<readonly string[]> {
  const upstream = options.resolutionAuditReport;
  const evidence = options.archiveRetentionEvidence;
  if (upstream.status === 'fail') {
    return [`publisher-tax-production-exception-resolution-audit-gate-not-clean: ${upstream.failureReason ?? 'unknown'}`];
  }
  if (evidence.source !== 'publisher-tax-filing-production-exception-audit-archive-retention') {
    return ['publisher-tax-production-exception-archive-must-use-retention-evidence'];
  }

  const holdReasons: string[] = [];
  const archive = evidence.archivePackage;
  const expectedIdentity = buildWorkersCoordinatorPublisherTaxProductionExceptionArchiveIdentity(upstream);
  const canonicalWithoutDigest = {
    schemaVersion: archive.schemaVersion,
    archiveId: archive.archiveId,
    createdAtMs: archive.createdAtMs,
    identity: archive.identity,
  } as const;
  const expectedDigest = await computeWorkersCoordinatorPublisherTaxProductionExceptionArchiveDigest(
    canonicalWithoutDigest,
  );

  if (archive.schemaVersion !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_SCHEMA_VERSION || !archive.archiveId) {
    holdReasons.push('publisher-tax-production-exception-archive-package-schema-or-id-invalid');
  }
  if (!isPositiveFinite(archive.createdAtMs) || archive.createdAtMs > evidence.capturedAtMs) {
    holdReasons.push('publisher-tax-production-exception-archive-package-timestamp-invalid');
  }
  if (!sameArchiveIdentity(archive.identity, expectedIdentity)) {
    holdReasons.push('publisher-tax-production-exception-archive-identity-mismatch');
  }
  if (archive.contentDigest !== expectedDigest) {
    holdReasons.push('publisher-tax-production-exception-archive-digest-mismatch');
  }

  const exportEvidence = evidence.archiveExport;
  if (
    exportEvidence.archiveId !== archive.archiveId ||
    !exportEvidence.archiveLocator ||
    exportEvidence.contentDigest !== archive.contentDigest ||
    exportEvidence.retentionPolicyId !== evidence.retentionPolicy.policyId ||
    !isPositiveFinite(exportEvidence.exportedAtMs) ||
    exportEvidence.exportedAtMs < archive.createdAtMs ||
    exportEvidence.exportedAtMs > evidence.capturedAtMs
  ) {
    holdReasons.push('publisher-tax-production-exception-archive-export-invalid');
  }

  validateRetentionPolicy(upstream, evidence, holdReasons);
  validateRetrievalProofs(expectedIdentity.providerFilingIds, evidence, holdReasons);

  const leakedNetworkAttempt = evidence.networkAttempts.find(
    (attempt) => !evidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(
      `publisher-tax-production-exception-archive-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`,
    );
  }
  if (!blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-tax-production-exception-archive-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!evidence.allowedOrigins.every((origin) => evidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-tax-production-exception-archive-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(evidence.sandboxFlags.length === 1 && evidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-tax-production-exception-archive-sandbox-must-remain-allow-scripts-only');
  }
  if (evidence.coop !== 'same-origin' || evidence.coep !== 'require-corp') {
    holdReasons.push('publisher-tax-production-exception-archive-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function validateRetentionPolicy(
  upstream: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport,
  evidence: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionEvidence,
  holdReasons: string[],
): void {
  const policy = evidence.retentionPolicy;
  const archive = evidence.archivePackage;
  const review = policy.deletionReview;
  const retentionDurationMs = policy.retentionEndsAtMs - policy.retentionStartsAtMs;
  const carriedForwardReviewTimes = upstream.actionResolutions.flatMap((entry) =>
    entry.outcome === 'carried-forward' && entry.carryForward ? [entry.carryForward.nextReviewAtMs] : [],
  );
  const latestCarryForwardReviewAtMs = Math.max(...carriedForwardReviewTimes, 0);
  const hasCarryForward = carriedForwardReviewTimes.length > 0;

  if (
    !policy.policyId ||
    !isPositiveFinite(policy.minimumRetentionMs) ||
    !isPositiveFinite(policy.retentionStartsAtMs) ||
    !isPositiveFinite(policy.retentionEndsAtMs) ||
    policy.retentionStartsAtMs > archive.createdAtMs ||
    policy.retentionEndsAtMs <= policy.retentionStartsAtMs ||
    retentionDurationMs < policy.minimumRetentionMs
  ) {
    holdReasons.push('publisher-tax-production-exception-retention-policy-window-invalid');
  }
  if (hasCarryForward && policy.retentionEndsAtMs <= latestCarryForwardReviewAtMs) {
    holdReasons.push('publisher-tax-production-exception-retention-expires-before-carry-forward-review');
  }
  if ((policy.legalHold || policy.operationalHold) && policy.deletionEligible) {
    holdReasons.push('publisher-tax-production-exception-retention-hold-allows-deletion');
  }
  if (!review.reviewId || !review.reason || !isPositiveFinite(review.reviewedAtMs) || review.reviewedAtMs > evidence.capturedAtMs) {
    holdReasons.push('publisher-tax-production-exception-retention-deletion-review-invalid');
  }

  if (policy.deletionEligible) {
    if (
      hasCarryForward ||
      policy.legalHold ||
      policy.operationalHold ||
      evidence.capturedAtMs < policy.retentionEndsAtMs ||
      review.decision !== 'eligible-after-retention' ||
      review.nextReviewAtMs !== undefined
    ) {
      holdReasons.push('publisher-tax-production-exception-retention-deletion-eligibility-invalid');
    }
  } else {
    if (review.decision !== 'retain') {
      holdReasons.push('publisher-tax-production-exception-retention-review-must-retain');
    }
    if (
      hasCarryForward &&
      (!isPositiveFinite(review.nextReviewAtMs) || review.nextReviewAtMs! < latestCarryForwardReviewAtMs)
    ) {
      holdReasons.push('publisher-tax-production-exception-retention-next-review-too-early');
    }
  }
}

function validateRetrievalProofs(
  providerFilingIds: readonly string[],
  evidence: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionEvidence,
  holdReasons: string[],
): void {
  const archive = evidence.archivePackage;
  const proofs = evidence.retrievalProofs;
  const proofIds = proofs.map((entry) => entry.retrievalProofId);
  if (new Set(proofIds).size !== proofIds.length || proofIds.some((entry) => !entry)) {
    holdReasons.push('publisher-tax-production-exception-archive-retrieval-proof-id-invalid');
  }

  const archiveIdProofs = proofs.filter(
    (entry) => entry.lookupKind === 'archive-id' && entry.lookupValue === archive.archiveId,
  );
  if (archiveIdProofs.length !== 1) {
    holdReasons.push('publisher-tax-production-exception-archive-id-retrieval-proof-missing-or-duplicate');
  }
  for (const providerFilingId of providerFilingIds) {
    const providerProofs = proofs.filter(
      (entry) => entry.lookupKind === 'provider-filing-id' && entry.lookupValue === providerFilingId,
    );
    if (providerProofs.length !== 1) {
      holdReasons.push(
        `publisher-tax-production-exception-provider-retrieval-proof-missing-or-duplicate: ${providerFilingId}`,
      );
    }
  }

  const allowedProviderIds = new Set(providerFilingIds);
  const invalidProof = proofs.find((entry) =>
    entry.archiveId !== archive.archiveId ||
    entry.contentDigest !== archive.contentDigest ||
    !isPositiveFinite(entry.retrievedAtMs) ||
    entry.retrievedAtMs < evidence.archiveExport.exportedAtMs ||
    entry.retrievedAtMs > evidence.capturedAtMs ||
    (entry.lookupKind === 'archive-id' && entry.lookupValue !== archive.archiveId) ||
    (entry.lookupKind === 'provider-filing-id' && !allowedProviderIds.has(entry.lookupValue)),
  );
  if (invalidProof) {
    holdReasons.push(`publisher-tax-production-exception-archive-retrieval-proof-invalid: ${invalidProof.retrievalProofId || 'unknown'}`);
  }
}

function canonicalArchivePackage(
  value: Omit<WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage, 'contentDigest'>,
): string {
  const identity = value.identity;
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    archiveId: value.archiveId,
    createdAtMs: value.createdAtMs,
    identity: {
      actionResolutionIds: sortedUnique(identity.actionResolutionIds),
      actionIds: sortedUnique(identity.actionIds),
      providerCorrectionOutcomeIds: sortedUnique(identity.providerCorrectionOutcomeIds),
      supportEscalationIds: sortedUnique(identity.supportEscalationIds),
      terminalPublisherStatusUpdateIds: sortedUnique(identity.terminalPublisherStatusUpdateIds),
      immutableIdentityAuditRecordIds: sortedUnique(identity.immutableIdentityAuditRecordIds),
      identityFingerprints: sortedUnique(identity.identityFingerprints),
      providerFilingIds: sortedUnique(identity.providerFilingIds),
      productionCallbackIds: sortedUnique(identity.productionCallbackIds),
      replayIds: sortedUnique(identity.replayIds),
      duplicateFilingSuppressionIds: sortedUnique(identity.duplicateFilingSuppressionIds),
      rollbackEmergencyDecisionIdentity: identity.rollbackEmergencyDecisionIdentity,
    },
  });
}

function sameArchiveIdentity(
  actual: WorkersCoordinatorPublisherTaxProductionExceptionArchiveIdentity,
  expected: WorkersCoordinatorPublisherTaxProductionExceptionArchiveIdentity,
): boolean {
  return (
    sameSet(actual.actionResolutionIds, expected.actionResolutionIds) &&
    sameSet(actual.actionIds, expected.actionIds) &&
    sameSet(actual.providerCorrectionOutcomeIds, expected.providerCorrectionOutcomeIds) &&
    sameSet(actual.supportEscalationIds, expected.supportEscalationIds) &&
    sameSet(actual.terminalPublisherStatusUpdateIds, expected.terminalPublisherStatusUpdateIds) &&
    sameSet(actual.immutableIdentityAuditRecordIds, expected.immutableIdentityAuditRecordIds) &&
    sameSet(actual.identityFingerprints, expected.identityFingerprints) &&
    sameSet(actual.providerFilingIds, expected.providerFilingIds) &&
    sameSet(actual.productionCallbackIds, expected.productionCallbackIds) &&
    sameSet(actual.replayIds, expected.replayIds) &&
    sameSet(actual.duplicateFilingSuppressionIds, expected.duplicateFilingSuppressionIds) &&
    actual.rollbackEmergencyDecisionIdentity.decisionId === expected.rollbackEmergencyDecisionIdentity.decisionId &&
    actual.rollbackEmergencyDecisionIdentity.rollbackPlanId === expected.rollbackEmergencyDecisionIdentity.rollbackPlanId &&
    actual.rollbackEmergencyDecisionIdentity.emergencyHoldSwitchId === expected.rollbackEmergencyDecisionIdentity.emergencyHoldSwitchId
  );
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find(
    (attempt) => !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('identity') || failureReason?.includes('digest') || failureReason?.includes('schema')) {
    return ['publisher-tax-production-exception-archive-integrity-hardening'];
  }
  if (failureReason?.includes('retrieval')) {
    return ['publisher-tax-production-exception-archive-retrieval-hardening'];
  }
  if (failureReason?.includes('retention') || failureReason?.includes('deletion')) {
    return ['publisher-tax-production-exception-retention-policy-hardening'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-tax-production-exception-archive-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-tax-production-exception-audit-archive-retention-failure: ${failureReason}`];
  }
  return ['publisher-tax-filing-production-exception-archive-restore-drill'];
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
