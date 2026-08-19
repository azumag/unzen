import type { WorkersCoordinatorRunnerNetworkAttempt } from './workers-coordinator-signed-runner-release-gate.js';
import {
  computeWorkersCoordinatorPublisherTaxProductionExceptionArchiveDigest,
  type WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage,
  type WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport,
  type WorkersCoordinatorPublisherTaxProductionExceptionRetentionPolicyEvidence,
} from './workers-coordinator-publisher-tax-production-exception-audit-archive-retention.js';

export type WorkersCoordinatorPublisherTaxProductionArchivePrimaryAvailability =
  | 'available'
  | 'missing'
  | 'corrupt';

export interface WorkersCoordinatorPublisherTaxProductionArchiveRestoreAttempt {
  readonly restoreAttemptId: string;
  readonly archiveId: string;
  readonly source: 'primary-archive' | 'backup-replica';
  readonly requestedAtMs: number;
  readonly restoredAtMs: number;
  readonly restoredPackage: WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveIntegrityCheck {
  readonly integrityCheckId: string;
  readonly archiveId: string;
  readonly verifierId: string;
  readonly expectedDigest: string;
  readonly observedDigest: string;
  readonly result: 'match' | 'mismatch';
  readonly checkedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveBackupRecovery {
  readonly recoveryId: string;
  readonly backupId: string;
  readonly archiveId: string;
  readonly backupLocator: string;
  readonly contentDigest: string;
  readonly recoveredAtMs: number;
  readonly restoredPackage: WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveAccessAuditRecord {
  readonly accessLogId: string;
  readonly archiveId: string;
  readonly actorId: string;
  readonly purpose: string;
  readonly operation: 'restore' | 'integrity-check' | 'backup-recovery';
  readonly occurredAtMs: number;
  readonly result: 'success' | 'failure';
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillEvidence {
  readonly source: 'publisher-tax-filing-production-exception-archive-restore-drill';
  readonly capturedAtMs: number;
  readonly primaryAvailability: WorkersCoordinatorPublisherTaxProductionArchivePrimaryAvailability;
  readonly restoreAttempt: WorkersCoordinatorPublisherTaxProductionArchiveRestoreAttempt;
  readonly integrityChecks: readonly WorkersCoordinatorPublisherTaxProductionArchiveIntegrityCheck[];
  readonly backupRecovery?: WorkersCoordinatorPublisherTaxProductionArchiveBackupRecovery;
  readonly accessAuditRecords: readonly WorkersCoordinatorPublisherTaxProductionArchiveAccessAuditRecord[];
  readonly retentionPolicySnapshot: WorkersCoordinatorPublisherTaxProductionExceptionRetentionPolicyEvidence;
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillOptions {
  readonly archiveRetentionReport: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport;
  readonly restoreDrillEvidence: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillEvidence;
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport {
  readonly runtime: 'publisher-tax-filing-production-exception-archive-restore-drill-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly archiveRetentionEvidence: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport;
  readonly primaryAvailability: WorkersCoordinatorPublisherTaxProductionArchivePrimaryAvailability;
  readonly restoreAttempt: WorkersCoordinatorPublisherTaxProductionArchiveRestoreAttempt;
  readonly integrityChecks: readonly WorkersCoordinatorPublisherTaxProductionArchiveIntegrityCheck[];
  readonly backupRecovery?: WorkersCoordinatorPublisherTaxProductionArchiveBackupRecovery;
  readonly accessAuditRecords: readonly WorkersCoordinatorPublisherTaxProductionArchiveAccessAuditRecord[];
  readonly retentionPolicySnapshot: WorkersCoordinatorPublisherTaxProductionExceptionRetentionPolicyEvidence;
  readonly restoreSummary: {
    readonly archiveId: string;
    readonly restoreSource: 'primary-archive' | 'backup-replica';
    readonly integrityCheckCount: number;
    readonly successfulIntegrityCheckCount: number;
    readonly accessAuditRecordCount: number;
    readonly backupRecoveryUsed: boolean;
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringRestoreVerification: {
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

export async function runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate(
  options: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillOptions,
): Promise<WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport> {
  const upstream = options.archiveRetentionReport;
  const evidence = options.restoreDrillEvidence;
  const blockedNonCoordinatorCdnNetworkAttempt = selectBlockedNonCoordinatorCdnNetworkAttempt(evidence);
  const holdReasons = await selectHoldReasons(options, blockedNonCoordinatorCdnNetworkAttempt);
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-tax-filing-production-exception-archive-restore-drill-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: upstream.previewRunnerUrl,
    archiveRetentionEvidence: upstream,
    primaryAvailability: evidence.primaryAvailability,
    restoreAttempt: evidence.restoreAttempt,
    integrityChecks: evidence.integrityChecks,
    backupRecovery: evidence.backupRecovery,
    accessAuditRecords: evidence.accessAuditRecords,
    retentionPolicySnapshot: evidence.retentionPolicySnapshot,
    restoreSummary: {
      archiveId: upstream.archivePackage.archiveId,
      restoreSource: evidence.restoreAttempt.source,
      integrityCheckCount: evidence.integrityChecks.length,
      successfulIntegrityCheckCount: evidence.integrityChecks.filter((entry) => entry.result === 'match').length,
      accessAuditRecordCount: evidence.accessAuditRecords.length,
      backupRecoveryUsed: evidence.backupRecovery !== undefined,
    },
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'production exception archive / retention gate has already passed',
        'the restored package exactly preserves archive ID, schema, identity set, and canonical SHA-256 digest',
        'a current integrity check independently confirms the expected and observed archive digest match',
        'missing or corrupt primary storage can recover from a traceable backup replica with identical archive identity and digest',
        'restore, integrity-check, and backup-recovery operations have explicit access-audit records',
        'retention, hold, deletion eligibility, and deletion-review state remain unchanged during restore verification',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact during restore verification',
      ],
      holdReasons,
    },
    securityBoundaryDuringRestoreVerification: {
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
  options: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillOptions,
  blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null,
): Promise<readonly string[]> {
  const upstream = options.archiveRetentionReport;
  const evidence = options.restoreDrillEvidence;
  if (upstream.status === 'fail') {
    return [`publisher-tax-production-exception-archive-retention-gate-not-clean: ${upstream.failureReason ?? 'unknown'}`];
  }
  if (evidence.source !== 'publisher-tax-filing-production-exception-archive-restore-drill') {
    return ['publisher-tax-production-exception-archive-restore-must-use-drill-evidence'];
  }

  const holdReasons: string[] = [];
  const archive = upstream.archivePackage;
  const latestUpstreamAtMs = Math.max(
    upstream.archiveExport.exportedAtMs,
    ...upstream.retrievalProofs.map((entry) => entry.retrievedAtMs),
    upstream.retentionPolicy.deletionReview.reviewedAtMs,
    0,
  );
  if (!isPositiveFinite(evidence.capturedAtMs) || evidence.capturedAtMs < latestUpstreamAtMs) {
    holdReasons.push('publisher-tax-production-exception-archive-restore-captured-before-archive-verification-complete');
  }

  const restore = evidence.restoreAttempt;
  const restoredDigest = await recomputeArchiveDigest(restore.restoredPackage);
  if (
    !restore.restoreAttemptId ||
    restore.archiveId !== archive.archiveId ||
    !isPositiveFinite(restore.requestedAtMs) ||
    !isPositiveFinite(restore.restoredAtMs) ||
    restore.restoredAtMs < restore.requestedAtMs ||
    restore.restoredAtMs > evidence.capturedAtMs ||
    !sameArchivePackage(restore.restoredPackage, archive) ||
    restoredDigest !== archive.contentDigest
  ) {
    holdReasons.push('publisher-tax-production-exception-archive-restore-package-invalid');
  }

  if (evidence.primaryAvailability === 'available') {
    if (restore.source !== 'primary-archive' || evidence.backupRecovery !== undefined) {
      holdReasons.push('publisher-tax-production-exception-archive-restore-primary-path-invalid');
    }
  } else {
    if (restore.source !== 'backup-replica' || !evidence.backupRecovery) {
      holdReasons.push('publisher-tax-production-exception-archive-restore-backup-required');
    }
  }

  if (evidence.backupRecovery) {
    const backup = evidence.backupRecovery;
    const backupDigest = await recomputeArchiveDigest(backup.restoredPackage);
    if (
      !backup.recoveryId ||
      !backup.backupId ||
      !backup.backupLocator ||
      backup.archiveId !== archive.archiveId ||
      backup.contentDigest !== archive.contentDigest ||
      !isPositiveFinite(backup.recoveredAtMs) ||
      backup.recoveredAtMs > evidence.capturedAtMs ||
      !sameArchivePackage(backup.restoredPackage, archive) ||
      backupDigest !== archive.contentDigest ||
      !sameArchivePackage(backup.restoredPackage, restore.restoredPackage)
    ) {
      holdReasons.push('publisher-tax-production-exception-archive-restore-backup-invalid');
    }
  }

  validateIntegrityChecks(archive, evidence, holdReasons);
  validateAccessAuditRecords(evidence, holdReasons);

  if (!sameRetentionPolicy(evidence.retentionPolicySnapshot, upstream.retentionPolicy)) {
    holdReasons.push('publisher-tax-production-exception-archive-restore-retention-state-changed');
  }

  const leakedNetworkAttempt = evidence.networkAttempts.find(
    (attempt) => !evidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(
      `publisher-tax-production-exception-archive-restore-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`,
    );
  }
  if (!blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-tax-production-exception-archive-restore-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!evidence.allowedOrigins.every((origin) => evidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-tax-production-exception-archive-restore-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(evidence.sandboxFlags.length === 1 && evidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-tax-production-exception-archive-restore-sandbox-must-remain-allow-scripts-only');
  }
  if (evidence.coop !== 'same-origin' || evidence.coep !== 'require-corp') {
    holdReasons.push('publisher-tax-production-exception-archive-restore-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function validateIntegrityChecks(
  archive: WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage,
  evidence: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillEvidence,
  holdReasons: string[],
): void {
  const successful = evidence.integrityChecks.filter(
    (entry) =>
      entry.archiveId === archive.archiveId &&
      entry.result === 'match' &&
      entry.expectedDigest === archive.contentDigest &&
      entry.observedDigest === archive.contentDigest &&
      isPositiveFinite(entry.checkedAtMs) &&
      entry.checkedAtMs <= evidence.capturedAtMs &&
      Boolean(entry.integrityCheckId) &&
      Boolean(entry.verifierId),
  );
  if (successful.length === 0) {
    holdReasons.push('publisher-tax-production-exception-archive-restore-integrity-check-missing-or-failed');
  }

  const newestCheckAtMs = Math.max(...successful.map((entry) => entry.checkedAtMs), 0);
  if (newestCheckAtMs < evidence.restoreAttempt.restoredAtMs) {
    holdReasons.push('publisher-tax-production-exception-archive-restore-integrity-check-stale');
  }

  if (evidence.integrityChecks.some((entry) => entry.archiveId !== archive.archiveId)) {
    holdReasons.push('publisher-tax-production-exception-archive-restore-integrity-check-archive-mismatch');
  }
}

function validateAccessAuditRecords(
  evidence: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillEvidence,
  holdReasons: string[],
): void {
  const archiveId = evidence.restoreAttempt.archiveId;
  const requiredOperations: WorkersCoordinatorPublisherTaxProductionArchiveAccessAuditRecord['operation'][] = [
    'restore',
    'integrity-check',
  ];
  if (evidence.backupRecovery) requiredOperations.push('backup-recovery');

  for (const operation of requiredOperations) {
    const matching = evidence.accessAuditRecords.filter(
      (entry) => entry.operation === operation && entry.archiveId === archiveId && entry.result === 'success',
    );
    if (
      matching.length === 0 ||
      matching.some(
        (entry) =>
          !entry.accessLogId ||
          !entry.actorId ||
          !entry.purpose ||
          !isPositiveFinite(entry.occurredAtMs) ||
          entry.occurredAtMs > evidence.capturedAtMs,
      )
    ) {
      holdReasons.push(`publisher-tax-production-exception-archive-restore-access-audit-missing: ${operation}`);
    }
  }
}

async function recomputeArchiveDigest(
  archive: WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage,
): Promise<string> {
  return computeWorkersCoordinatorPublisherTaxProductionExceptionArchiveDigest({
    schemaVersion: archive.schemaVersion,
    archiveId: archive.archiveId,
    createdAtMs: archive.createdAtMs,
    identity: archive.identity,
  });
}

function sameArchivePackage(
  left: WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage,
  right: WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.archiveId === right.archiveId &&
    left.createdAtMs === right.createdAtMs &&
    left.contentDigest === right.contentDigest &&
    JSON.stringify(left.identity) === JSON.stringify(right.identity)
  );
}

function sameRetentionPolicy(
  left: WorkersCoordinatorPublisherTaxProductionExceptionRetentionPolicyEvidence,
  right: WorkersCoordinatorPublisherTaxProductionExceptionRetentionPolicyEvidence,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find(
    (attempt) => !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  return failureReason
    ? []
    : ['publisher-tax-filing-production-exception-archive-disaster-recovery-operations'];
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}
