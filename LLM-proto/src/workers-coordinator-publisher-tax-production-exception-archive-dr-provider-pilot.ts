import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
  type EvidenceValidationStatus,
  type EvidenceLevel,
  type ReadinessStatus,
} from './evidence.js';
import type { WorkersCoordinatorRunnerNetworkAttempt } from './workers-coordinator-signed-runner-release-gate.js';
import type { WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsReport } from './workers-coordinator-publisher-tax-production-exception-archive-disaster-recovery-operations.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PILOT_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-pilot' as const;

export interface WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotRetrieval {
  readonly operationId: string;
  readonly storageId: string;
  readonly locator: string;
  readonly archiveId: string;
  readonly observedContentDigest: string;
  readonly requestedAtMs: number;
  readonly completedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotRestoreExecution {
  readonly executionId: string;
  readonly scheduleId: string;
  readonly sourceStorageId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly recoveryPointAtMs: number;
  readonly postRestoreIntegrityCheckId: string;
  readonly observedContentDigest: string;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload {
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly replicaSiteId: string;
  readonly replicaRegion: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly primaryRetrieval: WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotRetrieval;
  readonly backupRetrieval: WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotRetrieval;
  readonly restoreExecution: WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotRestoreExecution;
  readonly primarySnapshotAtMs: number;
  readonly backupSnapshotAtMs: number;
  readonly replicationLagMs: number;
  readonly recoveryOwnerId: string;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
  readonly incidentIds: readonly string[];
  readonly retentionPolicySnapshot: WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsReport['retentionPolicySnapshot'];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotOptions {
  readonly disasterRecoveryReport: WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsReport;
  readonly providerPilotEvidence: EvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload>;
  readonly evidenceValidationOptions?: EvidenceValidationOptions;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport {
  readonly runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-pilot-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly disasterRecoveryEvidence: WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsReport;
  readonly providerEvidenceSummary: {
    readonly validationStatus: EvidenceValidationStatus;
    readonly claimedEvidenceLevel?: EvidenceLevel;
    readonly effectiveEvidenceLevel?: EvidenceLevel;
    readonly claimedReadinessStatus?: ReadinessStatus;
    readonly effectiveReadinessStatus?: ReadinessStatus;
    readonly evidenceKind: string;
    readonly runId: string;
  };
  readonly pilotSummary: {
    readonly archiveId: string;
    readonly primaryRetrievalOperationId: string;
    readonly backupRetrievalOperationId: string;
    readonly restoreExecutionId: string;
    readonly recoveryDurationMs: number;
    readonly recoveryPointAgeMs: number;
    readonly backupAgeMs: number;
    readonly replicationLagMs: number;
  };
  readonly retentionPolicySnapshot: WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsReport['retentionPolicySnapshot'];
  readonly securityBoundaryDuringProviderPilot: {
    readonly allowedOrigins: readonly string[];
    readonly cspConnectSrc: readonly string[];
    readonly sandboxFlags: readonly string[];
    readonly coop: string | null;
    readonly coep: string | null;
    readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly holdReasons: readonly string[];
  };
  readonly failureReason?: string;
  readonly bottlenecksToIssue: readonly string[];
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotGate(
  options: WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotOptions,
): Promise<WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport> {
  const upstream = options.disasterRecoveryReport;
  const validation = await validateEvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload>(
    options.providerPilotEvidence,
    options.evidenceValidationOptions,
  );
  const payload = validation.envelope?.payload;
  const blockedAttempt = payload ? selectBlockedAttempt(payload) : null;
  const holdReasons = selectHoldReasons(options, validation, payload, blockedAttempt);
  const failureReason = holdReasons[0];

  const restore = payload?.restoreExecution;
  const recoveryDurationMs = restore ? restore.completedAtMs - restore.startedAtMs : 0;
  const recoveryPointAgeMs = restore ? restore.startedAtMs - restore.recoveryPointAtMs : 0;
  const backupAgeMs = payload && restore ? restore.startedAtMs - payload.backupSnapshotAtMs : 0;

  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-pilot-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: upstream.previewRunnerUrl,
    disasterRecoveryEvidence: upstream,
    providerEvidenceSummary: {
      validationStatus: validation.status,
      claimedEvidenceLevel: validation.claimedEvidenceLevel,
      effectiveEvidenceLevel: validation.effectiveEvidenceLevel,
      claimedReadinessStatus: validation.claimedReadinessStatus,
      effectiveReadinessStatus: validation.effectiveReadinessStatus,
      evidenceKind: options.providerPilotEvidence.evidenceKind,
      runId: options.providerPilotEvidence.runId,
    },
    pilotSummary: {
      archiveId: payload?.archiveId ?? '',
      primaryRetrievalOperationId: payload?.primaryRetrieval.operationId ?? '',
      backupRetrievalOperationId: payload?.backupRetrieval.operationId ?? '',
      restoreExecutionId: restore?.executionId ?? '',
      recoveryDurationMs,
      recoveryPointAgeMs,
      backupAgeMs,
      replicationLagMs: payload?.replicationLagMs ?? 0,
    },
    retentionPolicySnapshot: payload?.retentionPolicySnapshot ?? upstream.retentionPolicySnapshot,
    securityBoundaryDuringProviderPilot: {
      allowedOrigins: payload?.allowedOrigins ?? [],
      cspConnectSrc: payload?.cspConnectSrc ?? [],
      sandboxFlags: payload?.sandboxFlags ?? [],
      coop: payload?.coop ?? null,
      coep: payload?.coep ?? null,
      blockedNonCoordinatorCdnNetworkAttempt: blockedAttempt,
    },
    promoteHoldThresholds: {
      decision: failureReason ? 'hold' : 'promote',
      holdReasons,
    },
    failureReason,
    bottlenecksToIssue: failureReason
      ? []
      : ['publisher-tax-filing-production-exception-archive-dr-provider-production-readiness'],
  };
}

function selectHoldReasons(
  options: WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotOptions,
  validation: Awaited<ReturnType<typeof validateEvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload>>>,
  payload: WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload | undefined,
  blockedAttempt: WorkersCoordinatorRunnerNetworkAttempt | null,
): string[] {
  const upstream = options.disasterRecoveryReport;
  if (upstream.status === 'fail') {
    return [`publisher-tax-production-exception-archive-dr-operations-not-clean: ${upstream.failureReason ?? 'unknown'}`];
  }

  const reasons: string[] = [];
  if (validation.status !== 'valid') {
    reasons.push(`publisher-tax-production-exception-archive-dr-provider-pilot-evidence-${validation.status}`);
  }
  if (!evidenceSupportsReadiness(validation, 'verified-pilot')) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-requires-captured-and-verified-evidence');
  }
  if (options.providerPilotEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PILOT_EVIDENCE_KIND) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-evidence-kind-invalid');
  }
  if (!payload) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-payload-missing');
    return reasons;
  }

  const upstreamProviderPayload = upstream.restoreDrillEvidence.archiveRetentionEvidence.archivePackage;
  const upstreamProviderEnvelope = upstream.restoreDrillEvidence.archiveRetentionEvidence.resolutionAuditEvidence;
  const drProviderPayload = upstream.restoreDrillEvidence.archiveRetentionEvidence.archivePackage;
  void upstreamProviderEnvelope;
  void drProviderPayload;

  const archive = upstream.restoreDrillEvidence.archiveRetentionEvidence.archivePackage;
  const expectedIncidentIds = [...new Set(upstream.incidents.map((incident) => incident.incidentId))].sort();
  const actualIncidentIds = [...new Set(payload.incidentIds)].sort();

  if (
    !payload.providerName ||
    !payload.accountId ||
    !payload.primaryStorageId ||
    !payload.backupStorageId ||
    !payload.replicaSiteId ||
    !payload.replicaRegion
  ) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-provider-identity-missing');
  }
  if (payload.archiveId !== archive.archiveId || payload.archiveContentDigest !== archive.contentDigest) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-archive-identity-mismatch');
  }
  if (
    payload.recoveryOwnerId !== upstream.ownership.recoveryOwnerId ||
    payload.onCallRoute !== upstream.ownership.onCallRoute ||
    payload.escalationTarget !== upstream.ownership.escalationTarget ||
    JSON.stringify(actualIncidentIds) !== JSON.stringify(expectedIncidentIds)
  ) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-operations-identity-mismatch');
  }
  if (JSON.stringify(payload.retentionPolicySnapshot) !== JSON.stringify(upstream.retentionPolicySnapshot)) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-retention-state-changed');
  }

  validateRetrieval('primary', payload.primaryRetrieval, payload.primaryStorageId, archive.archiveId, archive.contentDigest, reasons);
  validateRetrieval('backup', payload.backupRetrieval, payload.backupStorageId, archive.archiveId, archive.contentDigest, reasons);

  const restore = payload.restoreExecution;
  const recoveryDurationMs = restore.completedAtMs - restore.startedAtMs;
  const recoveryPointAgeMs = restore.startedAtMs - restore.recoveryPointAtMs;
  const backupAgeMs = restore.startedAtMs - payload.backupSnapshotAtMs;
  if (
    !restore.executionId ||
    restore.scheduleId !== upstream.schedule.scheduleId ||
    ![payload.primaryStorageId, payload.backupStorageId].includes(restore.sourceStorageId) ||
    !isPositive(restore.startedAtMs) ||
    !isPositive(restore.completedAtMs) ||
    restore.completedAtMs < restore.startedAtMs ||
    !isPositive(restore.recoveryPointAtMs) ||
    restore.recoveryPointAtMs > restore.startedAtMs ||
    !restore.postRestoreIntegrityCheckId ||
    restore.observedContentDigest !== archive.contentDigest
  ) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-restore-execution-invalid');
  }
  if (recoveryDurationMs > upstream.objectives.rtoMs) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-rto-breached');
  }
  if (recoveryPointAgeMs > upstream.objectives.rpoMs) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-rpo-breached');
  }
  if (
    !isPositive(payload.primarySnapshotAtMs) ||
    !isPositive(payload.backupSnapshotAtMs) ||
    payload.primarySnapshotAtMs > restore.startedAtMs ||
    payload.backupSnapshotAtMs > restore.startedAtMs ||
    payload.replicationLagMs < 0 ||
    payload.replicationLagMs !== Math.max(0, payload.primarySnapshotAtMs - payload.backupSnapshotAtMs)
  ) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-snapshot-evidence-invalid');
  }
  if (backupAgeMs > upstream.objectives.maxBackupAgeMs) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-backup-age-breached');
  }
  if (payload.replicationLagMs > upstream.objectives.maxReplicationLagMs) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-replication-lag-breached');
  }

  const leaked = payload.networkAttempts.find(
    (attempt) => !payload.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leaked) {
    reasons.push(`publisher-tax-production-exception-archive-dr-provider-pilot-network-leak: ${originOf(leaked.url)}`);
  }
  if (!blockedAttempt) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-missing-blocked-network-attempt');
  }
  if (!payload.allowedOrigins.every((origin) => payload.cspConnectSrc.includes(origin))) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-csp-invalid');
  }
  if (!(payload.sandboxFlags.length === 1 && payload.sandboxFlags[0] === 'allow-scripts')) {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-sandbox-invalid');
  }
  if (payload.coop !== 'same-origin' || payload.coep !== 'require-corp') {
    reasons.push('publisher-tax-production-exception-archive-dr-provider-pilot-cross-origin-isolation-lost');
  }

  void upstreamProviderPayload;
  return reasons;
}

function validateRetrieval(
  kind: 'primary' | 'backup',
  retrieval: WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotRetrieval,
  expectedStorageId: string,
  archiveId: string,
  digest: string,
  reasons: string[],
): void {
  if (
    !retrieval.operationId ||
    retrieval.storageId !== expectedStorageId ||
    !retrieval.locator ||
    retrieval.archiveId !== archiveId ||
    retrieval.observedContentDigest !== digest ||
    !isPositive(retrieval.requestedAtMs) ||
    !isPositive(retrieval.completedAtMs) ||
    retrieval.completedAtMs < retrieval.requestedAtMs
  ) {
    reasons.push(`publisher-tax-production-exception-archive-dr-provider-pilot-${kind}-retrieval-invalid`);
  }
}

function selectBlockedAttempt(
  payload: WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return payload.networkAttempts.find(
    (attempt) => !payload.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
