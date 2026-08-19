import type {
  EvidenceEnvelope,
  EvidenceLevel,
  EvidenceValidationOptions,
  EvidenceValidationStatus,
  ReadinessStatus,
} from './evidence.js';
import { validateEvidenceEnvelope } from './evidence.js';
import type { WorkersCoordinatorRunnerNetworkAttempt } from './workers-coordinator-signed-runner-release-gate.js';
import type { WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport } from './workers-coordinator-publisher-tax-production-exception-archive-restore-drill.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_SCHEMA_VERSION = '1.0.0' as const;

export interface WorkersCoordinatorPublisherTaxProductionArchiveDrSchedule {
  readonly scheduleId: string;
  readonly cadenceMs: number;
  readonly lastSuccessfulDrillAtMs: number;
  readonly nextDueAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveDrObjectives {
  readonly rtoMs: number;
  readonly rpoMs: number;
  readonly maxBackupAgeMs: number;
  readonly maxReplicationLagMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveDrMeasurements {
  readonly recoveryStartedAtMs: number;
  readonly recoveryCompletedAtMs: number;
  readonly recoveryPointAtMs: number;
  readonly primarySnapshotAtMs: number;
  readonly backupSnapshotAtMs: number;
  readonly replicationLagMs: number;
  readonly measuredAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveDrOwnership {
  readonly recoveryOwnerId: string;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
}

export type WorkersCoordinatorPublisherTaxProductionArchiveDrIncidentTrigger =
  | 'primary-unavailable'
  | 'backup-recovery-used'
  | 'drill-overdue'
  | 'rto-breach'
  | 'rpo-breach'
  | 'backup-age-breach'
  | 'replication-lag-breach';

export interface WorkersCoordinatorPublisherTaxProductionArchiveDrIncident {
  readonly incidentId: string;
  readonly restoreAttemptId: string;
  readonly trigger: WorkersCoordinatorPublisherTaxProductionArchiveDrIncidentTrigger;
  readonly severity: 'sev1' | 'sev2' | 'sev3';
  readonly ownerId: string;
  readonly escalationTarget: string;
  readonly status: 'open' | 'mitigating' | 'resolved';
  readonly openedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveProviderPayload {
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly replicaSiteId: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly capturedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsEvidence {
  readonly source: 'publisher-tax-filing-production-exception-archive-disaster-recovery-operations';
  readonly schemaVersion: typeof PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_SCHEMA_VERSION;
  readonly capturedAtMs: number;
  readonly schedule: WorkersCoordinatorPublisherTaxProductionArchiveDrSchedule;
  readonly objectives: WorkersCoordinatorPublisherTaxProductionArchiveDrObjectives;
  readonly measurements: WorkersCoordinatorPublisherTaxProductionArchiveDrMeasurements;
  readonly ownership: WorkersCoordinatorPublisherTaxProductionArchiveDrOwnership;
  readonly incidents: readonly WorkersCoordinatorPublisherTaxProductionArchiveDrIncident[];
  readonly providerEvidence: EvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPayload>;
  readonly retentionPolicySnapshot: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport['retentionPolicySnapshot'];
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsOptions {
  readonly restoreDrillReport: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport;
  readonly disasterRecoveryEvidence: WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsEvidence;
  readonly providerEvidenceValidationOptions?: EvidenceValidationOptions;
}

export interface WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsReport {
  readonly runtime: 'publisher-tax-filing-production-exception-archive-disaster-recovery-operations-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly restoreDrillEvidence: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport;
  readonly schedule: WorkersCoordinatorPublisherTaxProductionArchiveDrSchedule;
  readonly objectives: WorkersCoordinatorPublisherTaxProductionArchiveDrObjectives;
  readonly measurements: WorkersCoordinatorPublisherTaxProductionArchiveDrMeasurements;
  readonly ownership: WorkersCoordinatorPublisherTaxProductionArchiveDrOwnership;
  readonly incidents: readonly WorkersCoordinatorPublisherTaxProductionArchiveDrIncident[];
  readonly providerEvidenceSummary: {
    readonly validationStatus: EvidenceValidationStatus;
    readonly claimedEvidenceLevel?: EvidenceLevel;
    readonly effectiveEvidenceLevel?: EvidenceLevel;
    readonly claimedReadinessStatus?: ReadinessStatus;
    readonly effectiveReadinessStatus?: ReadinessStatus;
    readonly provenanceNote: string;
  };
  readonly drSummary: {
    readonly archiveId: string;
    readonly recoveryDurationMs: number;
    readonly recoveryPointAgeMs: number;
    readonly backupAgeMs: number;
    readonly replicationLagMs: number;
    readonly incidentTriggerCount: number;
    readonly backupRecoveryUsed: boolean;
  };
  readonly retentionPolicySnapshot: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport['retentionPolicySnapshot'];
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringDisasterRecoveryOperations: {
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

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate(
  options: WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsOptions,
): Promise<WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsReport> {
  const upstream = options.restoreDrillReport;
  const evidence = options.disasterRecoveryEvidence;
  const providerValidation = await validateEvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPayload>(
    evidence.providerEvidence,
    options.providerEvidenceValidationOptions,
  );
  const blockedAttempt = selectBlockedAttempt(evidence);
  const holdReasons = selectHoldReasons(options, providerValidation, blockedAttempt);
  const recoveryDurationMs = evidence.measurements.recoveryCompletedAtMs - evidence.measurements.recoveryStartedAtMs;
  const recoveryPointAgeMs = evidence.measurements.recoveryStartedAtMs - evidence.measurements.recoveryPointAtMs;
  const backupAgeMs = evidence.measurements.recoveryStartedAtMs - evidence.measurements.backupSnapshotAtMs;
  const incidentTriggers = requiredIncidentTriggers(options);
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-tax-filing-production-exception-archive-disaster-recovery-operations-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: upstream.previewRunnerUrl,
    restoreDrillEvidence: upstream,
    schedule: evidence.schedule,
    objectives: evidence.objectives,
    measurements: evidence.measurements,
    ownership: evidence.ownership,
    incidents: evidence.incidents,
    providerEvidenceSummary: {
      validationStatus: providerValidation.status,
      claimedEvidenceLevel: providerValidation.claimedEvidenceLevel,
      effectiveEvidenceLevel: providerValidation.effectiveEvidenceLevel,
      claimedReadinessStatus: providerValidation.claimedReadinessStatus,
      effectiveReadinessStatus: providerValidation.effectiveReadinessStatus,
      provenanceNote: providerValidation.effectiveEvidenceLevel === 'captured-and-verified'
        ? 'provider evidence is independently captured-and-verified for this gate input'
        : 'provider identifiers remain contract/self-reported evidence and do not prove a real archival provider run',
    },
    drSummary: {
      archiveId: evidence.archiveId,
      recoveryDurationMs,
      recoveryPointAgeMs,
      backupAgeMs,
      replicationLagMs: evidence.measurements.replicationLagMs,
      incidentTriggerCount: incidentTriggers.length,
      backupRecoveryUsed: upstream.backupRecovery !== undefined,
    },
    retentionPolicySnapshot: evidence.retentionPolicySnapshot,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'archive restore / integrity drill gate has already passed',
        'restore drill cadence is explicit, internally consistent, and not overdue',
        'measured recovery duration and recovery-point age remain within RTO/RPO',
        'backup age and replication lag remain within configured freshness thresholds',
        'recovery owner, on-call route, and escalation target are explicit',
        'every primary/backup exception or threshold breach has a traceable incident record',
        'provider evidence is validated without overstating self-reported provenance',
        'archive identity, digest, retention/hold/deletion-review state, and network boundary remain unchanged',
      ],
      holdReasons,
    },
    securityBoundaryDuringDisasterRecoveryOperations: {
      cspConnectSrc: evidence.cspConnectSrc,
      sandboxFlags: evidence.sandboxFlags,
      coop: evidence.coop,
      coep: evidence.coep,
      allowedOrigins: evidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt: blockedAttempt,
    },
    failureReason,
    bottlenecksToIssue: failureReason ? [] : ['publisher-tax-filing-production-exception-archive-dr-provider-pilot'],
  };
}

function selectHoldReasons(
  options: WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsOptions,
  providerValidation: Awaited<ReturnType<typeof validateEvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPayload>>>,
  blockedAttempt: WorkersCoordinatorRunnerNetworkAttempt | null,
): string[] {
  const upstream = options.restoreDrillReport;
  const evidence = options.disasterRecoveryEvidence;
  if (upstream.status === 'fail') return [`publisher-tax-production-exception-archive-restore-drill-not-clean: ${upstream.failureReason ?? 'unknown'}`];
  if (evidence.source !== 'publisher-tax-filing-production-exception-archive-disaster-recovery-operations') return ['publisher-tax-production-exception-archive-dr-must-use-operations-evidence'];
  const reasons: string[] = [];
  const { schedule, objectives, measurements, ownership } = evidence;
  const recoveryDurationMs = measurements.recoveryCompletedAtMs - measurements.recoveryStartedAtMs;
  const recoveryPointAgeMs = measurements.recoveryStartedAtMs - measurements.recoveryPointAtMs;
  const backupAgeMs = measurements.recoveryStartedAtMs - measurements.backupSnapshotAtMs;

  if (evidence.schemaVersion !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_SCHEMA_VERSION || !isPositive(evidence.capturedAtMs)) reasons.push('publisher-tax-production-exception-archive-dr-schema-or-capture-invalid');
  if (!schedule.scheduleId || !isPositive(schedule.cadenceMs) || schedule.lastSuccessfulDrillAtMs !== upstream.restoreAttempt.restoredAtMs || schedule.nextDueAtMs !== schedule.lastSuccessfulDrillAtMs + schedule.cadenceMs) reasons.push('publisher-tax-production-exception-archive-dr-schedule-invalid');
  if (evidence.capturedAtMs > schedule.nextDueAtMs) reasons.push('publisher-tax-production-exception-archive-dr-drill-overdue');
  if (![objectives.rtoMs, objectives.rpoMs, objectives.maxBackupAgeMs, objectives.maxReplicationLagMs].every(isPositive)) reasons.push('publisher-tax-production-exception-archive-dr-objectives-invalid');
  if (![measurements.recoveryStartedAtMs, measurements.recoveryCompletedAtMs, measurements.recoveryPointAtMs, measurements.primarySnapshotAtMs, measurements.backupSnapshotAtMs, measurements.measuredAtMs].every(isPositive) || measurements.recoveryCompletedAtMs < measurements.recoveryStartedAtMs || measurements.measuredAtMs > evidence.capturedAtMs || measurements.recoveryPointAtMs > measurements.recoveryStartedAtMs || measurements.backupSnapshotAtMs > measurements.recoveryStartedAtMs) reasons.push('publisher-tax-production-exception-archive-dr-measurements-invalid');
  if (measurements.replicationLagMs < 0 || measurements.replicationLagMs !== Math.max(0, measurements.primarySnapshotAtMs - measurements.backupSnapshotAtMs)) reasons.push('publisher-tax-production-exception-archive-dr-replication-lag-evidence-invalid');
  if (recoveryDurationMs > objectives.rtoMs) reasons.push('publisher-tax-production-exception-archive-dr-rto-breached');
  if (recoveryPointAgeMs > objectives.rpoMs) reasons.push('publisher-tax-production-exception-archive-dr-rpo-breached');
  if (backupAgeMs > objectives.maxBackupAgeMs) reasons.push('publisher-tax-production-exception-archive-dr-backup-age-breached');
  if (measurements.replicationLagMs > objectives.maxReplicationLagMs) reasons.push('publisher-tax-production-exception-archive-dr-replication-lag-breached');
  if (!ownership.recoveryOwnerId || !ownership.onCallRoute || !ownership.escalationTarget) reasons.push('publisher-tax-production-exception-archive-dr-ownership-invalid');

  const archive = upstream.archiveRetentionEvidence.archivePackage;
  if (evidence.archiveId !== archive.archiveId || evidence.archiveContentDigest !== archive.contentDigest) reasons.push('publisher-tax-production-exception-archive-dr-archive-identity-changed');
  if (JSON.stringify(evidence.retentionPolicySnapshot) !== JSON.stringify(upstream.retentionPolicySnapshot)) reasons.push('publisher-tax-production-exception-archive-dr-retention-state-changed');

  if (providerValidation.status !== 'valid') reasons.push(`publisher-tax-production-exception-archive-dr-provider-evidence-${providerValidation.status}`);
  const payload = providerValidation.envelope?.payload;
  if (!payload || !payload.providerName || !payload.accountId || !payload.primaryStorageId || !payload.backupStorageId || !payload.replicaSiteId || payload.archiveId !== archive.archiveId || payload.archiveContentDigest !== archive.contentDigest || payload.capturedAtMs > evidence.capturedAtMs) reasons.push('publisher-tax-production-exception-archive-dr-provider-payload-invalid');

  const required = requiredIncidentTriggers(options);
  const incidentIds = new Set<string>();
  for (const incident of evidence.incidents) {
    if (!incident.incidentId || incidentIds.has(incident.incidentId) || incident.restoreAttemptId !== upstream.restoreAttempt.restoreAttemptId || !incident.ownerId || !incident.escalationTarget || !isPositive(incident.openedAtMs) || incident.openedAtMs > evidence.capturedAtMs) reasons.push('publisher-tax-production-exception-archive-dr-incident-invalid');
    incidentIds.add(incident.incidentId);
  }
  for (const trigger of required) {
    const found = evidence.incidents.some((incident) => incident.trigger === trigger && incident.ownerId === ownership.recoveryOwnerId && incident.escalationTarget === ownership.escalationTarget);
    if (!found) reasons.push(`publisher-tax-production-exception-archive-dr-incident-missing: ${trigger}`);
  }

  const leaked = evidence.networkAttempts.find((attempt) => !evidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked);
  if (leaked) reasons.push(`publisher-tax-production-exception-archive-dr-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leaked.url)}`);
  if (!blockedAttempt) reasons.push('publisher-tax-production-exception-archive-dr-missing-blocked-non-coordinator-cdn-network-attempt');
  if (!evidence.allowedOrigins.every((origin) => evidence.cspConnectSrc.includes(origin))) reasons.push('publisher-tax-production-exception-archive-dr-csp-connect-src-missing-coordinator-or-cdn-origin');
  if (!(evidence.sandboxFlags.length === 1 && evidence.sandboxFlags[0] === 'allow-scripts')) reasons.push('publisher-tax-production-exception-archive-dr-sandbox-must-remain-allow-scripts-only');
  if (evidence.coop !== 'same-origin' || evidence.coep !== 'require-corp') reasons.push('publisher-tax-production-exception-archive-dr-cross-origin-isolation-lost');
  return reasons;
}

function requiredIncidentTriggers(options: WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsOptions): WorkersCoordinatorPublisherTaxProductionArchiveDrIncidentTrigger[] {
  const upstream = options.restoreDrillReport;
  const e = options.disasterRecoveryEvidence;
  const triggers: WorkersCoordinatorPublisherTaxProductionArchiveDrIncidentTrigger[] = [];
  const recoveryDuration = e.measurements.recoveryCompletedAtMs - e.measurements.recoveryStartedAtMs;
  const rpoAge = e.measurements.recoveryStartedAtMs - e.measurements.recoveryPointAtMs;
  const backupAge = e.measurements.recoveryStartedAtMs - e.measurements.backupSnapshotAtMs;
  if (upstream.primaryAvailability !== 'available') triggers.push('primary-unavailable');
  if (upstream.backupRecovery) triggers.push('backup-recovery-used');
  if (e.capturedAtMs > e.schedule.nextDueAtMs) triggers.push('drill-overdue');
  if (recoveryDuration > e.objectives.rtoMs) triggers.push('rto-breach');
  if (rpoAge > e.objectives.rpoMs) triggers.push('rpo-breach');
  if (backupAge > e.objectives.maxBackupAgeMs) triggers.push('backup-age-breach');
  if (e.measurements.replicationLagMs > e.objectives.maxReplicationLagMs) triggers.push('replication-lag-breach');
  return [...new Set(triggers)];
}

function selectBlockedAttempt(evidence: WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsEvidence): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) => !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked) ?? null;
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
