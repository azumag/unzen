import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope } from '../src/evidence.js';
import type {
  WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsEvidence,
  WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsReport,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-disaster-recovery-operations.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PILOT_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotGate,
  type WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-pilot.js';

const ARTIFACT_CONTENT = 'verified DR provider pilot artifact';
const ARTIFACT_SHA256 = '8b3fbcc32808fb472a9d138f86e3a160899c168558be039fc0ba3441fa0820fa';
const ARCHIVE_DIGEST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const START = 1_787_140_000_000;
const RETENTION = { policyId: 'retention-v1', legalHold: false, operationalHold: false } as never;

function createDrInput(): WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsEvidence {
  return {
    source: 'publisher-tax-filing-production-exception-archive-disaster-recovery-operations',
    schemaVersion: '1.0.0',
    capturedAtMs: START + 90_000,
    schedule: {
      scheduleId: 'dr-schedule-1',
      cadenceMs: 86_400_000,
      lastSuccessfulDrillAtMs: START - 1_000,
      nextDueAtMs: START - 1_000 + 86_400_000,
    },
    objectives: {
      rtoMs: 60_000,
      rpoMs: 300_000,
      maxBackupAgeMs: 600_000,
      maxReplicationLagMs: 120_000,
    },
    measurements: {
      recoveryStartedAtMs: START,
      recoveryCompletedAtMs: START + 30_000,
      recoveryPointAtMs: START - 60_000,
      primarySnapshotAtMs: START - 10_000,
      backupSnapshotAtMs: START - 40_000,
      replicationLagMs: 30_000,
      measuredAtMs: START + 30_000,
    },
    ownership: {
      recoveryOwnerId: 'owner-1',
      onCallRoute: 'pager://archive-dr',
      escalationTarget: 'ops-lead',
    },
    incidents: [],
    providerEvidence: {
      schemaVersion: '1.0.0',
      evidenceKind: 'archive-provider-metadata',
      evidenceLevel: 'self-reported-runtime',
      readinessStatus: 'runtime-observed',
      producer: { name: 'provider-adapter', version: '1.0.0' },
      runId: 'dr-input-provider-1',
      capturedAt: '2026-08-19T12:50:00.000Z',
      environment: {
        runtime: 'node',
        runtimeVersion: '22.0.0',
        executionSurface: 'server-process',
      },
      redaction: { applied: true, policyVersion: 'provider-redaction-v1' },
      payload: {
        providerName: 'archive-provider',
        accountId: 'acct-1',
        primaryStorageId: 'primary-1',
        backupStorageId: 'backup-1',
        replicaSiteId: 'replica-site-1',
        archiveId: 'archive-1',
        archiveContentDigest: ARCHIVE_DIGEST,
        capturedAtMs: START + 20_000,
      },
    },
    retentionPolicySnapshot: RETENTION,
    archiveId: 'archive-1',
    archiveContentDigest: ARCHIVE_DIGEST,
    allowedOrigins: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    cspConnectSrc: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }],
  };
}

function createDrReport(input = createDrInput()): WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsReport {
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-disaster-recovery-operations-gate',
    status: 'pass',
    previewRunnerUrl: 'https://worker.unzen.dev/runner',
    restoreDrillEvidence: {
      archiveRetentionEvidence: {
        archivePackage: {
          archiveId: 'archive-1',
          contentDigest: ARCHIVE_DIGEST,
        },
      },
    } as never,
    schedule: input.schedule,
    objectives: input.objectives,
    measurements: input.measurements,
    ownership: input.ownership,
    incidents: input.incidents,
    providerEvidenceSummary: {
      validationStatus: 'valid',
      claimedEvidenceLevel: 'self-reported-runtime',
      effectiveEvidenceLevel: 'self-reported-runtime',
      claimedReadinessStatus: 'runtime-observed',
      effectiveReadinessStatus: 'runtime-observed',
      provenanceNote: 'self-reported provider metadata',
    },
    drSummary: {
      archiveId: 'archive-1',
      recoveryDurationMs: 30_000,
      recoveryPointAgeMs: 60_000,
      backupAgeMs: 40_000,
      replicationLagMs: 30_000,
      incidentTriggerCount: 0,
      backupRecoveryUsed: false,
    },
    retentionPolicySnapshot: RETENTION,
    promoteHoldThresholds: { decision: 'promote', promoteWhen: [], holdReasons: [] },
    securityBoundaryDuringDisasterRecoveryOperations: {
      cspConnectSrc: input.cspConnectSrc,
      sandboxFlags: input.sandboxFlags,
      coop: input.coop,
      coep: input.coep,
      allowedOrigins: input.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt: input.networkAttempts[0] ?? null,
    },
    bottlenecksToIssue: ['publisher-tax-filing-production-exception-archive-dr-provider-pilot'],
  };
}

function createPayload(): WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload {
  return {
    providerName: 'archive-provider',
    accountId: 'acct-1',
    primaryStorageId: 'primary-1',
    backupStorageId: 'backup-1',
    replicaSiteId: 'replica-site-1',
    replicaRegion: 'us-west-2',
    archiveId: 'archive-1',
    archiveContentDigest: ARCHIVE_DIGEST,
    primaryRetrieval: {
      operationId: 'primary-read-1',
      storageId: 'primary-1',
      locator: 'provider://primary/archive-1',
      archiveId: 'archive-1',
      observedContentDigest: ARCHIVE_DIGEST,
      requestedAtMs: START - 2_000,
      completedAtMs: START - 1_000,
    },
    backupRetrieval: {
      operationId: 'backup-read-1',
      storageId: 'backup-1',
      locator: 'provider://backup/archive-1',
      archiveId: 'archive-1',
      observedContentDigest: ARCHIVE_DIGEST,
      requestedAtMs: START - 2_000,
      completedAtMs: START - 500,
    },
    restoreExecution: {
      executionId: 'provider-restore-1',
      scheduleId: 'dr-schedule-1',
      sourceStorageId: 'primary-1',
      startedAtMs: START,
      completedAtMs: START + 30_000,
      recoveryPointAtMs: START - 60_000,
      postRestoreIntegrityCheckId: 'integrity-1',
      observedContentDigest: ARCHIVE_DIGEST,
    },
    primarySnapshotAtMs: START - 10_000,
    backupSnapshotAtMs: START - 40_000,
    replicationLagMs: 30_000,
    recoveryOwnerId: 'owner-1',
    onCallRoute: 'pager://archive-dr',
    escalationTarget: 'ops-lead',
    incidentIds: [],
    retentionPolicySnapshot: RETENTION,
    allowedOrigins: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    cspConnectSrc: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }],
  };
}

function createVerifiedEnvelope(payload = createPayload()): EvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload> {
  return {
    schemaVersion: '1.0.0',
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PILOT_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'verified-pilot',
    producer: {
      name: 'archive-provider-pilot-harness',
      version: '1.0.0',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
    },
    runId: 'provider-pilot-1',
    capturedAt: '2026-08-19T13:00:00.000Z',
    environment: {
      runtime: 'node',
      runtimeVersion: '22.0.0',
      executionSurface: 'server-process',
      os: { name: 'linux', version: '24.04' },
    },
    scenario: {
      feature: 'archive-dr-provider-pilot',
      scenario: 'primary-and-backup-retrieval-with-scheduled-restore',
      expectedResult: 'both replicas retrieve the same archive and scheduled restore meets DR objectives',
    },
    artifact: {
      locator: 'artifact://provider-pilot-1/report.json',
      sha256: ARTIFACT_SHA256,
      expiresAt: '2026-08-21T13:00:00.000Z',
    },
    verification: {
      verifier: 'unzen-ci-evidence-verifier',
      version: '1.0.0',
      verifiedAt: '2026-08-19T13:05:00.000Z',
      result: 'pass',
    },
    redaction: { applied: true, policyVersion: 'provider-pilot-v1' },
    payload,
  };
}

function createSelfReportedEnvelope(payload = createPayload()): EvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload> {
  return {
    schemaVersion: '1.0.0',
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PILOT_EVIDENCE_KIND,
    evidenceLevel: 'self-reported-runtime',
    readinessStatus: 'runtime-observed',
    producer: { name: 'archive-provider-pilot-harness', version: '1.0.0' },
    runId: 'provider-pilot-self-reported',
    capturedAt: '2026-08-19T13:00:00.000Z',
    environment: {
      runtime: 'node',
      runtimeVersion: '22.0.0',
      executionSurface: 'server-process',
    },
    redaction: { applied: true, policyVersion: 'provider-pilot-v1' },
    payload,
  };
}

const validationOptions = {
  now: '2026-08-19T13:30:00.000Z',
  trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
  loadArtifact: async (locator: string) => {
    expect(locator).toBe('artifact://provider-pilot-1/report.json');
    return ARTIFACT_CONTENT;
  },
  verifyArtifact: async () => ({
    verifier: 'unzen-ci-evidence-verifier',
    version: '1.0.0',
    verifiedAt: '2026-08-19T13:05:00.000Z',
    result: 'pass' as const,
  }),
} as const;

async function run(
  envelope: EvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload> = createVerifiedEnvelope(),
  drInput = createDrInput(),
  report = createDrReport(drInput),
  options = validationOptions,
) {
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotGate({
    disasterRecoveryReport: report,
    disasterRecoveryInputEvidence: drInput,
    providerPilotEvidence: envelope,
    evidenceValidationOptions: options,
  });
}

describe('publisher tax exception archive DR provider pilot gate', () => {
  it('passes independently verified primary/backup retrieval and scheduled restore evidence', async () => {
    const result = await run();
    expect(result.status).toBe('pass');
    expect(result.providerEvidenceSummary.effectiveEvidenceLevel).toBe('captured-and-verified');
    expect(result.providerEvidenceSummary.effectiveReadinessStatus).toBe('verified-pilot');
    expect(result.pilotSummary.primaryRetrievalOperationId).toBe('primary-read-1');
    expect(result.pilotSummary.backupRetrievalOperationId).toBe('backup-read-1');
    expect(result.bottlenecksToIssue).toEqual([
      'publisher-tax-filing-production-exception-archive-dr-provider-production-readiness',
    ]);
  });

  it('rejects otherwise valid self-reported provider evidence', async () => {
    const result = await run(createSelfReportedEnvelope());
    expect(result.status).toBe('fail');
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-dr-provider-pilot-requires-captured-and-verified-evidence',
    );
  });

  it('does not trust a captured-and-verified literal without artifact loading', async () => {
    const result = await run(createVerifiedEnvelope(), createDrInput(), createDrReport(), {
      now: '2026-08-19T13:30:00.000Z',
      trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
    });
    expect(result.status).toBe('fail');
    expect(result.providerEvidenceSummary.validationStatus).toBe('not-evaluated');
  });

  it('rejects the wrong provider pilot evidence kind', async () => {
    const envelope = { ...createVerifiedEnvelope(), evidenceKind: 'wrong-provider-pilot' } as EvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload>;
    const result = await run(envelope);
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-dr-provider-pilot-evidence-kind-invalid',
    );
  });

  it('rejects DR input evidence that no longer matches the upstream report', async () => {
    const input = createDrInput();
    const report = createDrReport(input);
    const changed = { ...input, ownership: { ...input.ownership, recoveryOwnerId: 'other-owner' } };
    const result = await run(createVerifiedEnvelope(), changed, report);
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-dr-provider-pilot-upstream-input-mismatch',
    );
  });

  it('rejects provider/account/storage identity changes', async () => {
    const payload = { ...createPayload(), accountId: 'different-account' };
    const result = await run(createVerifiedEnvelope(payload));
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-dr-provider-pilot-provider-identity-mismatch',
    );
  });

  it('requires a digest-matched backup retrieval even when restore uses primary', async () => {
    const base = createPayload();
    const payload = {
      ...base,
      backupRetrieval: { ...base.backupRetrieval, observedContentDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    };
    const result = await run(createVerifiedEnvelope(payload));
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-dr-provider-pilot-backup-retrieval-invalid',
    );
  });

  it('holds when the verified provider restore breaches RTO', async () => {
    const base = createPayload();
    const payload = {
      ...base,
      restoreExecution: { ...base.restoreExecution, completedAtMs: START + 90_000 },
    };
    const result = await run(createVerifiedEnvelope(payload));
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-dr-provider-pilot-rto-breached',
    );
  });

  it('rejects retention state mutation inside the verified artifact', async () => {
    const payload = { ...createPayload(), retentionPolicySnapshot: { changed: true } as never };
    const result = await run(createVerifiedEnvelope(payload));
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-dr-provider-pilot-retention-state-changed',
    );
  });

  it('rejects an unblocked non-Coordinator/CDN network attempt', async () => {
    const payload = {
      ...createPayload(),
      networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: false }],
    };
    const result = await run(createVerifiedEnvelope(payload));
    expect(result.promoteHoldThresholds.holdReasons.some((reason) => reason.includes('network-leak'))).toBe(true);
  });

  it('rejects artifact content whose digest does not match the verified envelope', async () => {
    const result = await run(createVerifiedEnvelope(), createDrInput(), createDrReport(), {
      ...validationOptions,
      loadArtifact: async () => 'tampered provider pilot artifact',
    });
    expect(result.status).toBe('fail');
    expect(result.providerEvidenceSummary.validationStatus).toBe('invalid');
  });
});
