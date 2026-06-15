import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherRecurringEmergencyControlEvidence,
} from './workers-coordinator-publisher-recurring-payout-operations.js';
import type {
  WorkersCoordinatorPublisherTaxReportingReport,
} from './workers-coordinator-publisher-tax-reporting.js';

export interface WorkersCoordinatorPublisherTaxFilingAttempt {
  readonly filingId: string;
  readonly submittedAtMs: number;
  readonly status: 'accepted' | 'rejected';
  readonly rejectionReason: string | null;
}

export interface WorkersCoordinatorPublisherTaxFilingRetryEvidence {
  readonly retryId: string;
  readonly previousRejectedFilingId: string;
  readonly retryFilingId: string;
  readonly attemptedAtMs: number;
  readonly resolved: boolean;
}

export interface WorkersCoordinatorPublisherTaxProviderFilingPacket {
  readonly packetId: string;
  readonly provider: 'irs-fire' | 'stripe-tax';
  readonly taxYear: number;
  readonly taxExportRecordIds: readonly string[];
  readonly filingAttempts: readonly WorkersCoordinatorPublisherTaxFilingAttempt[];
  readonly retryEvidence: readonly WorkersCoordinatorPublisherTaxFilingRetryEvidence[];
}

export interface WorkersCoordinatorPublisherTaxDocumentDownloadEvidence {
  readonly downloadId: string;
  readonly downloadedAtMs: number;
  readonly requesterIpHash: string;
}

export interface WorkersCoordinatorPublisherTaxDocumentDelivery {
  readonly deliveryId: string;
  readonly publisherId: string;
  readonly taxExportRecordId: string;
  readonly portalDocumentId: string;
  readonly deliveredAtMs: number;
  readonly acknowledgedAtMs: number;
  readonly downloadEvidence: readonly WorkersCoordinatorPublisherTaxDocumentDownloadEvidence[];
}

export interface WorkersCoordinatorPublisherCorrectedTaxFormWorkflow {
  readonly correctionId: string;
  readonly originalTaxExportRecordId: string;
  readonly correctedTaxExportRecordId: string;
  readonly adjustmentIds: readonly string[];
  readonly reason: 'refund' | 'reversal' | 'clawback';
  readonly generatedAtMs: number;
  readonly providerFilingId: string;
  readonly publisherDeliveryId: string;
}

export interface WorkersCoordinatorPublisherTaxDeadlineAlert {
  readonly alertId: string;
  readonly taxYear: number;
  readonly deadlineAtMs: number;
  readonly escalatedAtMs: number;
  readonly operatorId: string;
  readonly acknowledgedAtMs: number;
}

export interface WorkersCoordinatorPublisherPostFilingAuditEvidence {
  readonly auditId: string;
  readonly taxExportRecordIds: readonly string[];
  readonly accountingExportIds: readonly string[];
  readonly emergencyControlIds: readonly string[];
  readonly providerFilingIds: readonly string[];
  readonly publisherDeliveryIds: readonly string[];
  readonly reconciled: boolean;
}

export interface WorkersCoordinatorPublisherTaxFilingDeliveryEvidence {
  readonly source: 'publisher-reward-tax-filing-drill-delivery';
  readonly capturedAtMs: number;
  readonly providerFilingPackets: readonly WorkersCoordinatorPublisherTaxProviderFilingPacket[];
  readonly publisherDocumentDeliveries: readonly WorkersCoordinatorPublisherTaxDocumentDelivery[];
  readonly correctedFormWorkflows: readonly WorkersCoordinatorPublisherCorrectedTaxFormWorkflow[];
  readonly filingDeadlineAlerts: readonly WorkersCoordinatorPublisherTaxDeadlineAlert[];
  readonly postFilingAuditEvidence: readonly WorkersCoordinatorPublisherPostFilingAuditEvidence[];
  readonly emergencyControls: readonly WorkersCoordinatorPublisherRecurringEmergencyControlEvidence[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxFilingDeliveryOptions {
  readonly taxReportingReport: WorkersCoordinatorPublisherTaxReportingReport;
  readonly taxFilingDeliveryEvidence: WorkersCoordinatorPublisherTaxFilingDeliveryEvidence;
}

export interface WorkersCoordinatorPublisherTaxFilingDeliveryReport {
  readonly runtime: 'publisher-reward-tax-filing-delivery-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly providerFilingPackets: readonly WorkersCoordinatorPublisherTaxProviderFilingPacket[];
  readonly publisherDocumentDeliveries: readonly WorkersCoordinatorPublisherTaxDocumentDelivery[];
  readonly correctedFormWorkflows: readonly WorkersCoordinatorPublisherCorrectedTaxFormWorkflow[];
  readonly filingDeadlineAlerts: readonly WorkersCoordinatorPublisherTaxDeadlineAlert[];
  readonly postFilingAuditEvidence: readonly WorkersCoordinatorPublisherPostFilingAuditEvidence[];
  readonly emergencyHoldRollbackControls: readonly WorkersCoordinatorPublisherRecurringEmergencyControlEvidence[];
  readonly taxFilingDeliverySummary: {
    readonly taxYear: number | null;
    readonly packetCount: number;
    readonly acceptedFilingCount: number;
    readonly rejectedFilingCount: number;
    readonly deliveredDocumentCount: number;
    readonly correctedFormCount: number;
    readonly deadlineAlertCount: number;
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringTaxFilingDelivery: {
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

export function runWorkersCoordinatorPublisherTaxFilingDeliveryGate(
  options: WorkersCoordinatorPublisherTaxFilingDeliveryOptions,
): WorkersCoordinatorPublisherTaxFilingDeliveryReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.taxFilingDeliveryEvidence);
  const taxFilingDeliverySummary = summarizeTaxFilingDelivery(options.taxFilingDeliveryEvidence);
  const holdReasons = selectHoldReasons({
    ...options,
    taxFilingDeliverySummary,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-reward-tax-filing-delivery-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.taxReportingReport.previewRunnerUrl,
    providerFilingPackets: options.taxFilingDeliveryEvidence.providerFilingPackets,
    publisherDocumentDeliveries: options.taxFilingDeliveryEvidence.publisherDocumentDeliveries,
    correctedFormWorkflows: options.taxFilingDeliveryEvidence.correctedFormWorkflows,
    filingDeadlineAlerts: options.taxFilingDeliveryEvidence.filingDeadlineAlerts,
    postFilingAuditEvidence: options.taxFilingDeliveryEvidence.postFilingAuditEvidence,
    emergencyHoldRollbackControls: options.taxFilingDeliveryEvidence.emergencyControls,
    taxFilingDeliverySummary,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher tax reporting and 1099-K export gate has already passed',
        'provider filing packets include filing IDs, accepted and rejected attempt states, and resolved retry evidence',
        'publisher portal document deliveries include acknowledgement and download evidence',
        'corrected forms link refund, reversal, or clawback adjustments to post-filing provider and publisher delivery evidence',
        'filing deadline alerts escalate to an operator before the tax-year deadline',
        'post-filing audits reconcile tax export records, accounting exports, provider filings, deliveries, and emergency controls',
        'emergency hold and rollback controls remain outside signed runner control',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons,
    },
    securityBoundaryDuringTaxFilingDelivery: {
      cspConnectSrc: options.taxFilingDeliveryEvidence.cspConnectSrc,
      sandboxFlags: options.taxFilingDeliveryEvidence.sandboxFlags,
      coop: options.taxFilingDeliveryEvidence.coop,
      coep: options.taxFilingDeliveryEvidence.coep,
      allowedOrigins: options.taxFilingDeliveryEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherTaxFilingDeliveryOptions & {
  readonly taxFilingDeliverySummary: WorkersCoordinatorPublisherTaxFilingDeliveryReport['taxFilingDeliverySummary'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.taxReportingReport.status === 'fail') {
    return [`publisher-tax-reporting-gate-not-clean: ${input.taxReportingReport.failureReason ?? 'unknown'}`];
  }
  if (input.taxFilingDeliveryEvidence.source !== 'publisher-reward-tax-filing-drill-delivery') {
    return ['publisher-tax-filing-delivery-must-use-tax-filing-delivery-evidence'];
  }
  if (input.taxFilingDeliveryEvidence.providerFilingPackets.length === 0) {
    return ['publisher-tax-filing-delivery-provider-filing-packets-missing'];
  }
  if (input.taxFilingDeliveryEvidence.publisherDocumentDeliveries.length === 0) {
    return ['publisher-tax-filing-delivery-publisher-documents-missing'];
  }

  const holdReasons: string[] = [];
  const taxExportRecordIds = new Set(input.taxReportingReport.tax1099KExportRecords.map((record) => record.exportRecordId));
  const accountingExportIds = new Set(input.taxReportingReport.taxExportReconciliation.flatMap((reconciliation) =>
    reconciliation.accountingExportIds,
  ));
  const emergencyControlIds = new Set(input.taxReportingReport.emergencyHoldRollbackControls.map((control) => control.controlId));
  const filingIds = new Set(input.taxFilingDeliveryEvidence.providerFilingPackets.flatMap((packet) =>
    packet.filingAttempts.map((attempt) => attempt.filingId),
  ));
  const deliveryIds = new Set(input.taxFilingDeliveryEvidence.publisherDocumentDeliveries.map((delivery) => delivery.deliveryId));

  const invalidPacket = input.taxFilingDeliveryEvidence.providerFilingPackets.find((packet) => {
    const acceptedAttempts = packet.filingAttempts.filter((attempt) => attempt.status === 'accepted');
    const rejectedAttempts = packet.filingAttempts.filter((attempt) => attempt.status === 'rejected');
    return packet.packetId.length === 0 ||
      !Number.isInteger(packet.taxYear) ||
      packet.taxExportRecordIds.length === 0 ||
      packet.taxExportRecordIds.some((recordId) => !taxExportRecordIds.has(recordId)) ||
      packet.filingAttempts.length === 0 ||
      acceptedAttempts.length === 0 ||
      rejectedAttempts.length === 0 ||
      packet.filingAttempts.some((attempt) =>
        attempt.filingId.length === 0 ||
        !isPositiveFinite(attempt.submittedAtMs) ||
        (attempt.status === 'rejected' && (!attempt.rejectionReason || attempt.rejectionReason.length === 0)) ||
        (attempt.status === 'accepted' && attempt.rejectionReason !== null)
      ) ||
      packet.retryEvidence.length === 0 ||
      packet.retryEvidence.some((retry) =>
        retry.retryId.length === 0 ||
        !rejectedAttempts.some((attempt) => attempt.filingId === retry.previousRejectedFilingId) ||
        !acceptedAttempts.some((attempt) => attempt.filingId === retry.retryFilingId) ||
        !isPositiveFinite(retry.attemptedAtMs) ||
        !retry.resolved
      );
  });
  if (invalidPacket) {
    holdReasons.push(`publisher-tax-filing-delivery-provider-filing-packet-invalid: ${invalidPacket.packetId || 'unknown'}`);
  }

  const invalidDelivery = input.taxFilingDeliveryEvidence.publisherDocumentDeliveries.find((delivery) =>
    delivery.deliveryId.length === 0 ||
    delivery.publisherId.length === 0 ||
    !taxExportRecordIds.has(delivery.taxExportRecordId) ||
    delivery.portalDocumentId.length === 0 ||
    !isPositiveFinite(delivery.deliveredAtMs) ||
    !isPositiveFinite(delivery.acknowledgedAtMs) ||
    delivery.acknowledgedAtMs < delivery.deliveredAtMs ||
    delivery.downloadEvidence.length === 0 ||
    delivery.downloadEvidence.some((download) =>
      download.downloadId.length === 0 ||
      !isPositiveFinite(download.downloadedAtMs) ||
      download.downloadedAtMs < delivery.deliveredAtMs ||
      download.requesterIpHash.length === 0
    )
  );
  if (invalidDelivery) {
    holdReasons.push(`publisher-tax-filing-delivery-publisher-document-invalid: ${invalidDelivery.deliveryId || 'unknown'}`);
  }

  const invalidCorrection = input.taxFilingDeliveryEvidence.correctedFormWorkflows.find((correction) =>
    correction.correctionId.length === 0 ||
    !taxExportRecordIds.has(correction.originalTaxExportRecordId) ||
    !taxExportRecordIds.has(correction.correctedTaxExportRecordId) ||
    correction.originalTaxExportRecordId === correction.correctedTaxExportRecordId ||
    correction.adjustmentIds.length === 0 ||
    !isPositiveFinite(correction.generatedAtMs) ||
    !filingIds.has(correction.providerFilingId) ||
    !deliveryIds.has(correction.publisherDeliveryId)
  );
  if (invalidCorrection) {
    holdReasons.push(`publisher-tax-filing-delivery-corrected-form-invalid: ${invalidCorrection.correctionId || 'unknown'}`);
  }

  const invalidDeadlineAlert = input.taxFilingDeliveryEvidence.filingDeadlineAlerts.find((alert) =>
    alert.alertId.length === 0 ||
    !Number.isInteger(alert.taxYear) ||
    !isPositiveFinite(alert.deadlineAtMs) ||
    !isPositiveFinite(alert.escalatedAtMs) ||
    alert.escalatedAtMs >= alert.deadlineAtMs ||
    alert.operatorId.length === 0 ||
    !isPositiveFinite(alert.acknowledgedAtMs) ||
    alert.acknowledgedAtMs < alert.escalatedAtMs
  );
  if (invalidDeadlineAlert) {
    holdReasons.push(`publisher-tax-filing-delivery-deadline-alert-invalid: ${invalidDeadlineAlert.alertId || 'unknown'}`);
  }
  if (input.taxFilingDeliveryEvidence.filingDeadlineAlerts.length === 0) {
    holdReasons.push('publisher-tax-filing-delivery-deadline-alerts-missing');
  }

  const invalidAudit = input.taxFilingDeliveryEvidence.postFilingAuditEvidence.find((audit) =>
    audit.auditId.length === 0 ||
    audit.taxExportRecordIds.length === 0 ||
    audit.taxExportRecordIds.some((recordId) => !taxExportRecordIds.has(recordId)) ||
    audit.accountingExportIds.length === 0 ||
    audit.accountingExportIds.some((exportId) => !accountingExportIds.has(exportId)) ||
    audit.emergencyControlIds.length === 0 ||
    audit.emergencyControlIds.some((controlId) => !emergencyControlIds.has(controlId)) ||
    audit.providerFilingIds.length === 0 ||
    audit.providerFilingIds.some((filingId) => !filingIds.has(filingId)) ||
    audit.publisherDeliveryIds.length === 0 ||
    audit.publisherDeliveryIds.some((deliveryId) => !deliveryIds.has(deliveryId)) ||
    !audit.reconciled
  );
  if (invalidAudit) {
    holdReasons.push(`publisher-tax-filing-delivery-post-filing-audit-invalid: ${invalidAudit.auditId || 'unknown'}`);
  }
  if (input.taxFilingDeliveryEvidence.postFilingAuditEvidence.length === 0) {
    holdReasons.push('publisher-tax-filing-delivery-post-filing-audit-missing');
  }

  const missingEmergencyControl = input.taxReportingReport.emergencyHoldRollbackControls.find((control) =>
    !input.taxFilingDeliveryEvidence.emergencyControls.some((filingControl) =>
      filingControl.controlId === control.controlId &&
      emergencyControlIds.has(filingControl.controlId) &&
      filingControl.outsideSignedRunnerBoundary &&
      filingControl.activeHoldReasons.length === 0,
    ),
  );
  if (missingEmergencyControl) {
    holdReasons.push(`publisher-tax-filing-delivery-emergency-hold-rollback-controls-missing-or-active: ${missingEmergencyControl.controlId}`);
  }

  const leakedNetworkAttempt = input.taxFilingDeliveryEvidence.networkAttempts.find((attempt) =>
    !input.taxFilingDeliveryEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-tax-filing-delivery-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-tax-filing-delivery-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.taxFilingDeliveryEvidence.allowedOrigins.every((origin) => input.taxFilingDeliveryEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-tax-filing-delivery-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.taxFilingDeliveryEvidence.sandboxFlags.length === 1 && input.taxFilingDeliveryEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-tax-filing-delivery-sandbox-must-remain-allow-scripts-only');
  }
  if (input.taxFilingDeliveryEvidence.coop !== 'same-origin' || input.taxFilingDeliveryEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-tax-filing-delivery-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function summarizeTaxFilingDelivery(
  evidence: WorkersCoordinatorPublisherTaxFilingDeliveryEvidence,
): WorkersCoordinatorPublisherTaxFilingDeliveryReport['taxFilingDeliverySummary'] {
  const taxYears = new Set(evidence.providerFilingPackets.map((packet) => packet.taxYear));
  const attempts = evidence.providerFilingPackets.flatMap((packet) => packet.filingAttempts);
  return {
    taxYear: taxYears.size === 1 ? [...taxYears][0] : null,
    packetCount: evidence.providerFilingPackets.length,
    acceptedFilingCount: attempts.filter((attempt) => attempt.status === 'accepted').length,
    rejectedFilingCount: attempts.filter((attempt) => attempt.status === 'rejected').length,
    deliveredDocumentCount: evidence.publisherDocumentDeliveries.length,
    correctedFormCount: evidence.correctedFormWorkflows.length,
    deadlineAlertCount: evidence.filingDeadlineAlerts.length,
  };
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherTaxFilingDeliveryEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('provider-filing-packet')) {
    return ['publisher-tax-filing-provider-handoff-hardening'];
  }
  if (failureReason?.includes('publisher-document')) {
    return ['publisher-tax-filing-portal-delivery-hardening'];
  }
  if (failureReason?.includes('corrected-form')) {
    return ['publisher-tax-filing-corrected-form-workflow'];
  }
  if (failureReason?.includes('deadline-alert')) {
    return ['publisher-tax-filing-deadline-escalation'];
  }
  if (failureReason?.includes('post-filing-audit')) {
    return ['publisher-tax-filing-post-filing-audit-hardening'];
  }
  if (failureReason?.includes('emergency-hold') || failureReason?.includes('rollback')) {
    return ['publisher-tax-filing-emergency-control-workflow'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-tax-filing-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-tax-filing-delivery-failure: ${failureReason}`];
  }
  return ['publisher-tax-filing-real-provider-sandbox-run'];
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
