import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherTaxFilingDeliveryReport,
} from './workers-coordinator-publisher-tax-filing-delivery.js';

export interface WorkersCoordinatorPublisherTaxProviderSandboxSubmission {
  readonly submissionId: string;
  readonly providerFilingId: string;
  readonly providerTraceId: string;
  readonly idempotencyKey: string;
  readonly submittedAtMs: number;
  readonly completedAtMs: number;
  readonly status: 'accepted' | 'rejected';
  readonly rejectionReason: string | null;
}

export interface WorkersCoordinatorPublisherTaxProviderSandboxCallback {
  readonly callbackId: string;
  readonly providerTraceId: string;
  readonly receivedAtMs: number;
  readonly signatureVerified: boolean;
  readonly eventType: 'filing.accepted' | 'filing.rejected' | 'filing.corrected';
}

export interface WorkersCoordinatorPublisherTaxProviderSandboxRun {
  readonly runId: string;
  readonly provider: 'irs-fire' | 'stripe-tax';
  readonly environment: 'sandbox';
  readonly filingPacketId: string;
  readonly taxExportRecordIds: readonly string[];
  readonly retryEvidenceIds: readonly string[];
  readonly submission: WorkersCoordinatorPublisherTaxProviderSandboxSubmission;
  readonly callbacks: readonly WorkersCoordinatorPublisherTaxProviderSandboxCallback[];
}

export interface WorkersCoordinatorPublisherTaxProviderSandboxReconciliation {
  readonly reconciliationId: string;
  readonly sandboxRunIds: readonly string[];
  readonly providerFilingIds: readonly string[];
  readonly taxExportRecordIds: readonly string[];
  readonly accountingExportIds: readonly string[];
  readonly correctedFormWorkflowIds: readonly string[];
  readonly publisherDeliveryIds: readonly string[];
  readonly postFilingAuditIds: readonly string[];
  readonly emergencyControlIds: readonly string[];
  readonly reconciled: boolean;
}

export interface WorkersCoordinatorPublisherTaxProviderSandboxFilingEvidence {
  readonly source: 'publisher-tax-filing-real-provider-sandbox-run';
  readonly capturedAtMs: number;
  readonly sandboxRuns: readonly WorkersCoordinatorPublisherTaxProviderSandboxRun[];
  readonly sandboxReconciliations: readonly WorkersCoordinatorPublisherTaxProviderSandboxReconciliation[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxProviderSandboxFilingOptions {
  readonly taxFilingDeliveryReport: WorkersCoordinatorPublisherTaxFilingDeliveryReport;
  readonly sandboxFilingEvidence: WorkersCoordinatorPublisherTaxProviderSandboxFilingEvidence;
}

export interface WorkersCoordinatorPublisherTaxProviderSandboxFilingReport {
  readonly runtime: 'publisher-tax-filing-real-provider-sandbox-run-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly sandboxRuns: readonly WorkersCoordinatorPublisherTaxProviderSandboxRun[];
  readonly sandboxReconciliations: readonly WorkersCoordinatorPublisherTaxProviderSandboxReconciliation[];
  readonly sandboxFilingSummary: {
    readonly runCount: number;
    readonly acceptedSubmissionCount: number;
    readonly rejectedSubmissionCount: number;
    readonly callbackCount: number;
    readonly reconciledRunCount: number;
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringProviderSandboxFiling: {
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

export function runWorkersCoordinatorPublisherTaxProviderSandboxFilingGate(
  options: WorkersCoordinatorPublisherTaxProviderSandboxFilingOptions,
): WorkersCoordinatorPublisherTaxProviderSandboxFilingReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.sandboxFilingEvidence);
  const sandboxFilingSummary = summarizeSandboxFiling(options.sandboxFilingEvidence);
  const holdReasons = selectHoldReasons({
    ...options,
    sandboxFilingSummary,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-tax-filing-real-provider-sandbox-run-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.taxFilingDeliveryReport.previewRunnerUrl,
    sandboxRuns: options.sandboxFilingEvidence.sandboxRuns,
    sandboxReconciliations: options.sandboxFilingEvidence.sandboxReconciliations,
    sandboxFilingSummary,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher tax filing drill and publisher delivery gate has already passed',
        'real provider sandbox run submits known provider filing packets with idempotency keys',
        'provider sandbox receipts include trace IDs, accepted and rejected outcomes, and signed callbacks',
        'sandbox provider filing IDs reconcile against publisher delivery and post-filing audit evidence',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons,
    },
    securityBoundaryDuringProviderSandboxFiling: {
      cspConnectSrc: options.sandboxFilingEvidence.cspConnectSrc,
      sandboxFlags: options.sandboxFilingEvidence.sandboxFlags,
      coop: options.sandboxFilingEvidence.coop,
      coep: options.sandboxFilingEvidence.coep,
      allowedOrigins: options.sandboxFilingEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherTaxProviderSandboxFilingOptions & {
  readonly sandboxFilingSummary: WorkersCoordinatorPublisherTaxProviderSandboxFilingReport['sandboxFilingSummary'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.taxFilingDeliveryReport.status === 'fail') {
    return [`publisher-tax-filing-delivery-gate-not-clean: ${input.taxFilingDeliveryReport.failureReason ?? 'unknown'}`];
  }
  if (input.sandboxFilingEvidence.source !== 'publisher-tax-filing-real-provider-sandbox-run') {
    return ['publisher-tax-provider-sandbox-filing-must-use-sandbox-run-evidence'];
  }
  if (input.sandboxFilingEvidence.sandboxRuns.length === 0) {
    return ['publisher-tax-provider-sandbox-filing-runs-missing'];
  }

  const holdReasons: string[] = [];
  const packetIds = new Set(input.taxFilingDeliveryReport.providerFilingPackets.map((packet) => packet.packetId));
  const exportRecordIds = new Set(input.taxFilingDeliveryReport.providerFilingPackets.flatMap((packet) =>
    packet.taxExportRecordIds,
  ));
  const retryIds = new Set(input.taxFilingDeliveryReport.providerFilingPackets.flatMap((packet) =>
    packet.retryEvidence.map((retry) => retry.retryId),
  ));
  const providerFilingIds = new Set(input.taxFilingDeliveryReport.providerFilingPackets.flatMap((packet) =>
    packet.filingAttempts.map((attempt) => attempt.filingId),
  ));
  const accountingExportIds = new Set(input.taxFilingDeliveryReport.postFilingAuditEvidence.flatMap((audit) =>
    audit.accountingExportIds,
  ));
  const correctedFormIds = new Set(input.taxFilingDeliveryReport.correctedFormWorkflows.map((workflow) =>
    workflow.correctionId,
  ));
  const publisherDeliveryIds = new Set(input.taxFilingDeliveryReport.publisherDocumentDeliveries.map((delivery) => delivery.deliveryId));
  const auditIds = new Set(input.taxFilingDeliveryReport.postFilingAuditEvidence.map((audit) => audit.auditId));
  const emergencyControlIds = new Set(input.taxFilingDeliveryReport.emergencyHoldRollbackControls.map((control) =>
    control.controlId,
  ));
  const sandboxRunIds = new Set(input.sandboxFilingEvidence.sandboxRuns.map((run) => run.runId));
  const sandboxProviderFilingIds = new Set(input.sandboxFilingEvidence.sandboxRuns.map((run) => run.submission.providerFilingId));

  const invalidRun = input.sandboxFilingEvidence.sandboxRuns.find((run) => {
    const callbackForSubmission = run.callbacks.find((callback) =>
      callback.providerTraceId === run.submission.providerTraceId &&
      callback.signatureVerified &&
      callback.eventType === (run.submission.status === 'accepted' ? 'filing.accepted' : 'filing.rejected'),
    );
    return run.runId.length === 0 ||
      run.environment !== 'sandbox' ||
      !packetIds.has(run.filingPacketId) ||
      run.taxExportRecordIds.length === 0 ||
      run.taxExportRecordIds.some((recordId) => !exportRecordIds.has(recordId)) ||
      run.retryEvidenceIds.length === 0 ||
      run.retryEvidenceIds.some((retryId) => !retryIds.has(retryId)) ||
      run.submission.submissionId.length === 0 ||
      !providerFilingIds.has(run.submission.providerFilingId) ||
      run.submission.providerTraceId.length === 0 ||
      run.submission.idempotencyKey.length === 0 ||
      !isPositiveFinite(run.submission.submittedAtMs) ||
      !isPositiveFinite(run.submission.completedAtMs) ||
      run.submission.completedAtMs < run.submission.submittedAtMs ||
      (run.submission.status === 'accepted' && run.submission.rejectionReason !== null) ||
      (run.submission.status === 'rejected' && (!run.submission.rejectionReason || run.submission.rejectionReason.length === 0)) ||
      !callbackForSubmission;
  });
  if (invalidRun) {
    holdReasons.push(`publisher-tax-provider-sandbox-filing-run-invalid: ${invalidRun.runId || 'unknown'}`);
  }
  if (input.sandboxFilingSummary.acceptedSubmissionCount === 0 || input.sandboxFilingSummary.rejectedSubmissionCount === 0) {
    holdReasons.push('publisher-tax-provider-sandbox-filing-must-include-accepted-and-rejected-submissions');
  }

  const invalidReconciliation = input.sandboxFilingEvidence.sandboxReconciliations.find((reconciliation) =>
    reconciliation.reconciliationId.length === 0 ||
    reconciliation.sandboxRunIds.length === 0 ||
    reconciliation.sandboxRunIds.some((runId) => !sandboxRunIds.has(runId)) ||
    reconciliation.providerFilingIds.length === 0 ||
    reconciliation.providerFilingIds.some((filingId) => !sandboxProviderFilingIds.has(filingId)) ||
    reconciliation.taxExportRecordIds.length === 0 ||
    reconciliation.taxExportRecordIds.some((recordId) => !exportRecordIds.has(recordId)) ||
    reconciliation.accountingExportIds.length === 0 ||
    reconciliation.accountingExportIds.some((exportId) => !accountingExportIds.has(exportId)) ||
    reconciliation.correctedFormWorkflowIds.length === 0 ||
    reconciliation.correctedFormWorkflowIds.some((correctionId) => !correctedFormIds.has(correctionId)) ||
    reconciliation.publisherDeliveryIds.length === 0 ||
    reconciliation.publisherDeliveryIds.some((deliveryId) => !publisherDeliveryIds.has(deliveryId)) ||
    reconciliation.postFilingAuditIds.length === 0 ||
    reconciliation.postFilingAuditIds.some((auditId) => !auditIds.has(auditId)) ||
    reconciliation.emergencyControlIds.length === 0 ||
    reconciliation.emergencyControlIds.some((controlId) => !emergencyControlIds.has(controlId)) ||
    !reconciliation.reconciled
  );
  if (invalidReconciliation) {
    holdReasons.push(`publisher-tax-provider-sandbox-filing-reconciliation-invalid: ${invalidReconciliation.reconciliationId || 'unknown'}`);
  }
  if (input.sandboxFilingEvidence.sandboxReconciliations.length === 0) {
    holdReasons.push('publisher-tax-provider-sandbox-filing-reconciliations-missing');
  }

  const leakedNetworkAttempt = input.sandboxFilingEvidence.networkAttempts.find((attempt) =>
    !input.sandboxFilingEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-tax-provider-sandbox-filing-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-tax-provider-sandbox-filing-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.sandboxFilingEvidence.allowedOrigins.every((origin) => input.sandboxFilingEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-tax-provider-sandbox-filing-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.sandboxFilingEvidence.sandboxFlags.length === 1 && input.sandboxFilingEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-tax-provider-sandbox-filing-sandbox-must-remain-allow-scripts-only');
  }
  if (input.sandboxFilingEvidence.coop !== 'same-origin' || input.sandboxFilingEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-tax-provider-sandbox-filing-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function summarizeSandboxFiling(
  evidence: WorkersCoordinatorPublisherTaxProviderSandboxFilingEvidence,
): WorkersCoordinatorPublisherTaxProviderSandboxFilingReport['sandboxFilingSummary'] {
  return {
    runCount: evidence.sandboxRuns.length,
    acceptedSubmissionCount: evidence.sandboxRuns.filter((run) => run.submission.status === 'accepted').length,
    rejectedSubmissionCount: evidence.sandboxRuns.filter((run) => run.submission.status === 'rejected').length,
    callbackCount: evidence.sandboxRuns.reduce((sum, run) => sum + run.callbacks.length, 0),
    reconciledRunCount: evidence.sandboxReconciliations.reduce((sum, reconciliation) => sum + reconciliation.sandboxRunIds.length, 0),
  };
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherTaxProviderSandboxFilingEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('run-invalid')) {
    return ['publisher-tax-provider-sandbox-run-hardening'];
  }
  if (failureReason?.includes('reconciliation')) {
    return ['publisher-tax-provider-sandbox-reconciliation-hardening'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-tax-provider-sandbox-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-tax-provider-sandbox-filing-failure: ${failureReason}`];
  }
  return ['publisher-tax-filing-production-cutover-readiness'];
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
