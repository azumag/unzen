import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherRecurringEmergencyControlEvidence,
} from './workers-coordinator-publisher-recurring-payout-operations.js';
import type {
  WorkersCoordinatorPublisherRevenueReportingReport,
} from './workers-coordinator-publisher-revenue-reporting.js';

export interface WorkersCoordinatorPublisherTaxProfile {
  readonly publisherId: string;
  readonly taxYear: number;
  readonly country: 'US';
  readonly taxClassification: 'individual' | 'business';
  readonly taxpayerIdLast4: string;
  readonly payoutProviderAccountId: string;
  readonly addressValidated: boolean;
  readonly w9SignedAtMs: number | null;
  readonly payable: boolean;
  readonly withholdingHoldReason: string | null;
}

export interface WorkersCoordinatorPublisherTaxYearSummary {
  readonly summaryId: string;
  readonly publisherId: string;
  readonly taxYear: number;
  readonly statementIds: readonly string[];
  readonly providerPayoutIds: readonly string[];
  readonly payoutProviderAccountId: string;
  readonly grossRewardUsd: number;
  readonly platformFeeRevenueUsd: number;
  readonly refundReversalClawbackAdjustmentUsd: number;
  readonly netPublisherPayoutUsd: number;
}

export interface WorkersCoordinatorPublisherTaxExportRecord {
  readonly exportRecordId: string;
  readonly publisherId: string;
  readonly taxYear: number;
  readonly taxFormType: '1099-K';
  readonly payoutProviderAccountId: string;
  readonly grossReportableUsd: number;
  readonly adjustmentUsd: number;
  readonly netPayoutUsd: number;
  readonly generatedAtMs: number;
  readonly readyForFiling: boolean;
}

export interface WorkersCoordinatorPublisherTaxExportReconciliation {
  readonly reconciliationId: string;
  readonly taxYear: number;
  readonly accountingExportIds: readonly string[];
  readonly revenueReportingGrossRewardUsd: number;
  readonly taxExportGrossReportableUsd: number;
  readonly revenueReportingNetPayoutUsd: number;
  readonly taxExportNetPayoutUsd: number;
}

export interface WorkersCoordinatorPublisherTaxReviewExport {
  readonly exportId: string;
  readonly generatedAtMs: number;
  readonly audience: 'finance' | 'operator-review';
  readonly taxYear: number;
  readonly taxProfilePublisherIds: readonly string[];
  readonly taxSummaryIds: readonly string[];
  readonly taxExportRecordIds: readonly string[];
  readonly reconciliationIds: readonly string[];
  readonly includesAccountingExportIds: boolean;
  readonly includesEmergencyControlIds: boolean;
}

export interface WorkersCoordinatorPublisherTaxReportingEvidence {
  readonly source: 'publisher-reward-tax-reporting-1099-k';
  readonly capturedAtMs: number;
  readonly publisherTaxProfiles: readonly WorkersCoordinatorPublisherTaxProfile[];
  readonly taxYearPublisherSummaries: readonly WorkersCoordinatorPublisherTaxYearSummary[];
  readonly tax1099KExportRecords: readonly WorkersCoordinatorPublisherTaxExportRecord[];
  readonly taxExportReconciliations: readonly WorkersCoordinatorPublisherTaxExportReconciliation[];
  readonly financeOperatorReviewExports: readonly WorkersCoordinatorPublisherTaxReviewExport[];
  readonly emergencyControls: readonly WorkersCoordinatorPublisherRecurringEmergencyControlEvidence[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxReportingOptions {
  readonly revenueReportingReport: WorkersCoordinatorPublisherRevenueReportingReport;
  readonly taxReportingEvidence: WorkersCoordinatorPublisherTaxReportingEvidence;
}

export interface WorkersCoordinatorPublisherTaxReportingReport {
  readonly runtime: 'publisher-reward-tax-reporting-1099-k-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly publisherTaxProfiles: readonly WorkersCoordinatorPublisherTaxProfile[];
  readonly taxYearPublisherSummaries: readonly WorkersCoordinatorPublisherTaxYearSummary[];
  readonly tax1099KExportRecords: readonly WorkersCoordinatorPublisherTaxExportRecord[];
  readonly taxExportReconciliation: readonly WorkersCoordinatorPublisherTaxExportReconciliation[];
  readonly financeOperatorReviewExports: readonly WorkersCoordinatorPublisherTaxReviewExport[];
  readonly taxHolds: readonly WorkersCoordinatorPublisherTaxProfile[];
  readonly emergencyHoldRollbackControls: readonly WorkersCoordinatorPublisherRecurringEmergencyControlEvidence[];
  readonly taxReportingSummary: {
    readonly currency: 'USD';
    readonly taxYear: number | null;
    readonly publisherCount: number;
    readonly grossReportableUsd: number;
    readonly adjustmentUsd: number;
    readonly netPayoutUsd: number;
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringTaxReporting: {
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

export function runWorkersCoordinatorPublisherTaxReportingGate(
  options: WorkersCoordinatorPublisherTaxReportingOptions,
): WorkersCoordinatorPublisherTaxReportingReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.taxReportingEvidence);
  const taxReportingSummary = summarizeTaxReporting(options.taxReportingEvidence);
  const taxHolds = options.taxReportingEvidence.publisherTaxProfiles.filter((profile) =>
    !profile.payable || profile.withholdingHoldReason !== null,
  );
  const holdReasons = selectHoldReasons({
    ...options,
    taxReportingSummary,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-reward-tax-reporting-1099-k-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.revenueReportingReport.previewRunnerUrl,
    publisherTaxProfiles: options.taxReportingEvidence.publisherTaxProfiles,
    taxYearPublisherSummaries: options.taxReportingEvidence.taxYearPublisherSummaries,
    tax1099KExportRecords: options.taxReportingEvidence.tax1099KExportRecords,
    taxExportReconciliation: options.taxReportingEvidence.taxExportReconciliations,
    financeOperatorReviewExports: options.taxReportingEvidence.financeOperatorReviewExports,
    taxHolds,
    emergencyHoldRollbackControls: options.taxReportingEvidence.emergencyControls,
    taxReportingSummary,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher payout operations revenue reporting gate has already passed',
        'payable publisher tax profiles include valid US tax identity, W-9, address, and payout provider account evidence',
        'tax-year publisher summaries link monthly statements, provider payout IDs, platform fee revenue, adjustments, and net payouts',
        '1099-K export records reconcile against revenue reporting summaries and accounting exports',
        'finance and operator review exports include tax profiles, summaries, export records, reconciliations, and controls',
        'emergency hold and rollback controls remain outside signed runner control',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons,
    },
    securityBoundaryDuringTaxReporting: {
      cspConnectSrc: options.taxReportingEvidence.cspConnectSrc,
      sandboxFlags: options.taxReportingEvidence.sandboxFlags,
      coop: options.taxReportingEvidence.coop,
      coep: options.taxReportingEvidence.coep,
      allowedOrigins: options.taxReportingEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherTaxReportingOptions & {
  readonly taxReportingSummary: WorkersCoordinatorPublisherTaxReportingReport['taxReportingSummary'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.revenueReportingReport.status === 'fail') {
    return [`publisher-revenue-reporting-gate-not-clean: ${input.revenueReportingReport.failureReason ?? 'unknown'}`];
  }
  if (input.taxReportingEvidence.source !== 'publisher-reward-tax-reporting-1099-k') {
    return ['publisher-tax-reporting-must-use-tax-reporting-evidence'];
  }
  if (input.taxReportingEvidence.publisherTaxProfiles.length === 0) {
    return ['publisher-tax-reporting-tax-profiles-missing'];
  }
  if (input.taxReportingEvidence.taxYearPublisherSummaries.length === 0) {
    return ['publisher-tax-reporting-tax-year-summaries-missing'];
  }
  if (input.taxReportingEvidence.tax1099KExportRecords.length === 0) {
    return ['publisher-tax-reporting-1099-k-export-records-missing'];
  }

  const holdReasons: string[] = [];
  const statementIds = new Set(input.revenueReportingReport.publisherMonthlyStatements.map((statement) => statement.statementId));
  const providerPayoutIds = new Set(
    input.revenueReportingReport.publisherMonthlyStatements.flatMap((statement) => statement.providerPayoutIds),
  );
  const accountingExportIds = new Set(
    input.revenueReportingReport.platformFeeRelaySpendMarginReconciliation.map((reconciliation) => reconciliation.accountingExportId),
  );
  const emergencyControlIds = new Set(input.revenueReportingReport.emergencyHoldRollbackControls.map((control) => control.controlId));
  const profilesByPublisher = new Map(input.taxReportingEvidence.publisherTaxProfiles.map((profile) => [profile.publisherId, profile]));
  const summariesByPublisher = new Map(input.taxReportingEvidence.taxYearPublisherSummaries.map((summary) => [summary.publisherId, summary]));
  const summaryIds = new Set(input.taxReportingEvidence.taxYearPublisherSummaries.map((summary) => summary.summaryId));
  const exportRecordIds = new Set(input.taxReportingEvidence.tax1099KExportRecords.map((record) => record.exportRecordId));
  const reconciliationIds = new Set(input.taxReportingEvidence.taxExportReconciliations.map((reconciliation) => reconciliation.reconciliationId));

  const invalidProfile = input.taxReportingEvidence.publisherTaxProfiles.find((profile) =>
    profile.publisherId.length === 0 ||
    !Number.isInteger(profile.taxYear) ||
    profile.taxYear < 2020 ||
    profile.country !== 'US' ||
    !/^\d{4}$/.test(profile.taxpayerIdLast4) ||
    profile.payoutProviderAccountId.length === 0 ||
    !profile.addressValidated ||
    !isPositiveFinite(profile.w9SignedAtMs) ||
    !profile.payable ||
    profile.withholdingHoldReason !== null
  );
  if (invalidProfile) {
    holdReasons.push(`publisher-tax-reporting-tax-profile-invalid-or-held: ${invalidProfile.publisherId || 'unknown'}`);
  }

  const invalidSummary = input.taxReportingEvidence.taxYearPublisherSummaries.find((summary) => {
    const profile = profilesByPublisher.get(summary.publisherId);
    const publisherStatements = input.revenueReportingReport.publisherMonthlyStatements.filter((statement) =>
      statement.publisherId === summary.publisherId,
    );
    const publisherAdjustments = input.revenueReportingReport.refundReversalClawbackAdjustments.filter((adjustment) =>
      adjustment.publisherId === summary.publisherId,
    );
    return summary.summaryId.length === 0 ||
      !profile ||
      summary.taxYear !== profile.taxYear ||
      summary.statementIds.length === 0 ||
      summary.statementIds.some((statementId) => !statementIds.has(statementId)) ||
      summary.providerPayoutIds.length === 0 ||
      summary.providerPayoutIds.some((providerPayoutId) => !providerPayoutIds.has(providerPayoutId)) ||
      summary.payoutProviderAccountId !== profile.payoutProviderAccountId ||
      !nearlyEqual(summary.grossRewardUsd, publisherStatements.reduce((sum, statement) => sum + statement.grossRewardUsd, 0)) ||
      !nearlyEqual(summary.platformFeeRevenueUsd, publisherStatements.reduce((sum, statement) => sum + statement.platformFeeUsd, 0)) ||
      !nearlyEqual(
        summary.refundReversalClawbackAdjustmentUsd,
        publisherAdjustments.reduce((sum, adjustment) => sum + adjustment.amountUsd, 0),
      ) ||
      !nearlyEqual(summary.netPublisherPayoutUsd, publisherStatements.reduce((sum, statement) => sum + statement.netPublisherPayoutUsd, 0));
  });
  if (invalidSummary) {
    holdReasons.push(`publisher-tax-reporting-tax-year-summary-invalid: ${invalidSummary.summaryId || 'unknown'}`);
  }

  const invalidExportRecord = input.taxReportingEvidence.tax1099KExportRecords.find((record) => {
    const summary = summariesByPublisher.get(record.publisherId);
    return record.exportRecordId.length === 0 ||
      record.taxFormType !== '1099-K' ||
      !summary ||
      record.taxYear !== summary.taxYear ||
      record.payoutProviderAccountId !== summary.payoutProviderAccountId ||
      !nearlyEqual(record.grossReportableUsd, summary.grossRewardUsd) ||
      !nearlyEqual(record.adjustmentUsd, summary.refundReversalClawbackAdjustmentUsd) ||
      !nearlyEqual(record.netPayoutUsd, summary.netPublisherPayoutUsd) ||
      !isPositiveFinite(record.generatedAtMs) ||
      !record.readyForFiling;
  });
  if (invalidExportRecord) {
    holdReasons.push(`publisher-tax-reporting-1099-k-export-record-invalid: ${invalidExportRecord.exportRecordId || 'unknown'}`);
  }

  const invalidReconciliation = input.taxReportingEvidence.taxExportReconciliations.find((reconciliation) =>
    reconciliation.reconciliationId.length === 0 ||
    !Number.isInteger(reconciliation.taxYear) ||
    reconciliation.accountingExportIds.length === 0 ||
    reconciliation.accountingExportIds.some((exportId) => !accountingExportIds.has(exportId)) ||
    !nearlyEqual(reconciliation.revenueReportingGrossRewardUsd, input.revenueReportingReport.revenueReportingSummary.grossRewardUsd) ||
    !nearlyEqual(reconciliation.taxExportGrossReportableUsd, input.taxReportingSummary.grossReportableUsd) ||
    !nearlyEqual(reconciliation.revenueReportingNetPayoutUsd, input.revenueReportingReport.revenueReportingSummary.netPublisherPayoutUsd) ||
    !nearlyEqual(reconciliation.taxExportNetPayoutUsd, input.taxReportingSummary.netPayoutUsd)
  );
  if (invalidReconciliation) {
    holdReasons.push(`publisher-tax-reporting-reconciliation-invalid: ${invalidReconciliation.reconciliationId || 'unknown'}`);
  }

  const missingReviewAudience = ['finance', 'operator-review']
    .filter((audience) => !input.taxReportingEvidence.financeOperatorReviewExports
      .some((reviewExport) => reviewExport.audience === audience));
  if (missingReviewAudience.length > 0) {
    holdReasons.push(`publisher-tax-reporting-review-export-audience-missing: ${missingReviewAudience.join(',')}`);
  }

  const invalidReviewExport = input.taxReportingEvidence.financeOperatorReviewExports.find((reviewExport) =>
    reviewExport.exportId.length === 0 ||
    !isPositiveFinite(reviewExport.generatedAtMs) ||
    !Number.isInteger(reviewExport.taxYear) ||
    reviewExport.taxProfilePublisherIds.length === 0 ||
    reviewExport.taxProfilePublisherIds.some((publisherId) => !profilesByPublisher.has(publisherId)) ||
    reviewExport.taxSummaryIds.length === 0 ||
    reviewExport.taxSummaryIds.some((summaryId) => !summaryIds.has(summaryId)) ||
    reviewExport.taxExportRecordIds.length === 0 ||
    reviewExport.taxExportRecordIds.some((recordId) => !exportRecordIds.has(recordId)) ||
    reviewExport.reconciliationIds.length === 0 ||
    reviewExport.reconciliationIds.some((reconciliationId) => !reconciliationIds.has(reconciliationId)) ||
    !reviewExport.includesAccountingExportIds ||
    !reviewExport.includesEmergencyControlIds
  );
  if (invalidReviewExport) {
    holdReasons.push(`publisher-tax-reporting-review-export-invalid: ${invalidReviewExport.exportId || 'unknown'}`);
  }

  const missingEmergencyControl = input.revenueReportingReport.emergencyHoldRollbackControls.find((control) =>
    !input.taxReportingEvidence.emergencyControls.some((taxControl) =>
      taxControl.controlId === control.controlId &&
      emergencyControlIds.has(taxControl.controlId) &&
      taxControl.outsideSignedRunnerBoundary &&
      taxControl.activeHoldReasons.length === 0,
    ),
  );
  if (missingEmergencyControl) {
    holdReasons.push(`publisher-tax-reporting-emergency-hold-rollback-controls-missing-or-active: ${missingEmergencyControl.controlId}`);
  }

  const leakedNetworkAttempt = input.taxReportingEvidence.networkAttempts.find((attempt) =>
    !input.taxReportingEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-tax-reporting-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-tax-reporting-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.taxReportingEvidence.allowedOrigins.every((origin) => input.taxReportingEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-tax-reporting-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.taxReportingEvidence.sandboxFlags.length === 1 && input.taxReportingEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-tax-reporting-sandbox-must-remain-allow-scripts-only');
  }
  if (input.taxReportingEvidence.coop !== 'same-origin' || input.taxReportingEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-tax-reporting-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function summarizeTaxReporting(
  evidence: WorkersCoordinatorPublisherTaxReportingEvidence,
): WorkersCoordinatorPublisherTaxReportingReport['taxReportingSummary'] {
  const taxYears = new Set(evidence.tax1099KExportRecords.map((record) => record.taxYear));
  return {
    currency: 'USD',
    taxYear: taxYears.size === 1 ? [...taxYears][0] : null,
    publisherCount: evidence.publisherTaxProfiles.length,
    grossReportableUsd: roundUsd(evidence.tax1099KExportRecords.reduce((sum, record) => sum + record.grossReportableUsd, 0)),
    adjustmentUsd: roundUsd(evidence.tax1099KExportRecords.reduce((sum, record) => sum + record.adjustmentUsd, 0)),
    netPayoutUsd: roundUsd(evidence.tax1099KExportRecords.reduce((sum, record) => sum + record.netPayoutUsd, 0)),
  };
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherTaxReportingEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('tax-profile')) {
    return ['publisher-tax-reporting-tax-profile-remediation'];
  }
  if (failureReason?.includes('tax-year-summary')) {
    return ['publisher-tax-reporting-tax-year-summary-hardening'];
  }
  if (failureReason?.includes('1099-k-export')) {
    return ['publisher-tax-reporting-1099-k-export-hardening'];
  }
  if (failureReason?.includes('reconciliation')) {
    return ['publisher-tax-reporting-accounting-reconciliation-hardening'];
  }
  if (failureReason?.includes('review-export')) {
    return ['publisher-tax-reporting-finance-operator-review-workflow'];
  }
  if (failureReason?.includes('emergency-hold') || failureReason?.includes('rollback')) {
    return ['publisher-tax-reporting-emergency-control-workflow'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-tax-reporting-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-tax-reporting-failure: ${failureReason}`];
  }
  return ['publisher-reward-tax-filing-drill-and-publisher-delivery'];
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.000_001;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
