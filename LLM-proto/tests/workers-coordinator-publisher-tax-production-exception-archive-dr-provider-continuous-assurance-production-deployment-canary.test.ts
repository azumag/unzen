import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope, EvidenceValidationOptions } from '../src/evidence.js';
import {
  CONTINUOUS_ASSURANCE_ENGINE_SERVICE,
  CONTINUOUS_ASSURANCE_PRODUCTION_CANARY_SERVICE,
  CONTINUOUS_ASSURANCE_RUNTIME_SERVICE,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_BOTTLENECK,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate,
  type ContinuousAssuranceDeploymentServiceRole,
  type ContinuousAssuranceProductionDeploymentCanaryPayload,
  type ContinuousAssuranceWorkerDeploymentIdentity,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.js';
import {
  CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE,
  CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE,
  CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE,
  CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.js';
import { handleContinuousAssuranceIndependentVerifierRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-independent-verifier.js';

const BASE = Date.parse('2026-08-20T03:00:00.000Z');
const ARTIFACT = 'verified production deployment canary artifact';
const ARTIFACT_SHA = createHash('sha256').update(ARTIFACT).digest('hex');
const VERIFIER = 'unzen-independent-evidence-verifier';
const DEPLOY_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const DEPLOYMENT_MANIFEST_SHA = 'f'.repeat(64);

function deployment(
  role: ContinuousAssuranceWorkerDeploymentIdentity['role'],
  service: string,
  index: number,
): ContinuousAssuranceWorkerDeploymentIdentity {
  return {
    role,
    service,
    versionId: `version-${role}-${index}`,
    versionTag: `deploy-${index}`,
    versionTimestamp: new Date(BASE - index * 1_000).toISOString(),
    configFingerprintSha256: String(index + 1).repeat(64).slice(0, 64),
  };
}

function payload(overrides: Partial<ContinuousAssuranceProductionDeploymentCanaryPayload> = {}): ContinuousAssuranceProductionDeploymentCanaryPayload {
  const scope = 'publisher-tax-exception-archive-dr';
  const cron = 'deployment-canary-idle';
  const scheduledTimeMs = BASE;
  const triggerKey = `${scope}:${cron}:${scheduledTimeMs}`;
  return {
    scope,
    cron,
    scheduledTimeMs,
    triggerKey,
    canaryRunId: `production-deployment-canary:${BASE + 60_000}`,
    startedAtMs: BASE,
    completedAtMs: BASE + 2,
    deployCommitSha: DEPLOY_COMMIT,
    deploymentManifestSha256: DEPLOYMENT_MANIFEST_SHA,
    deployments: [
      deployment('controller', CONTINUOUS_ASSURANCE_PRODUCTION_CANARY_SERVICE, 1),
      deployment('runtime', CONTINUOUS_ASSURANCE_RUNTIME_SERVICE, 2),
      deployment('engine', CONTINUOUS_ASSURANCE_ENGINE_SERVICE, 3),
      deployment('provider', CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE, 4),
      deployment('evidence', CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE, 5),
      deployment('pager', CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE, 6),
      deployment('verifier', CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE, 7),
    ],
    runtimeResult: {
      status: 'idle',
      triggerKey,
      cycleId: 'schedule-1:1787194800000',
      failureReason: null,
      actionIdempotencyKeys: [],
      latestCycleRunId: null,
      latestAggregateRunId: null,
      runtimeDelivery: { durableState: 'completed', replayCount: 0, replayed: false },
    },
    artifactLocator: 'r2://continuous-assurance-evidence/deployment-canary%2Ffixture.json',
    artifactSha256: ARTIFACT_SHA,
    verificationId: 'verification-production-deployment-canary-1',
    verifier: VERIFIER,
    verifierVersion: '1.0.0',
    negativeChecks: {
      badDispatchSecretRejected: true,
      duplicateCompletedDispatchSuppressed: true,
      versionOrConfigMismatchRejected: true,
      digestMismatchRejected: true,
      untrustedVerifierRejected: true,
    },
    capturedAtMs: BASE + 2,
    ...overrides,
  };
}

function envelope(value = payload()): EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload> {
  return {
    schemaVersion: '1.0.0',
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: {
      name: CONTINUOUS_ASSURANCE_PRODUCTION_CANARY_SERVICE,
      version: '1.0.0',
      commitSha: value.deployCommitSha,
    },
    runId: value.canaryRunId,
    capturedAt: new Date(value.capturedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers',
      runtimeVersion: 'managed',
      executionSurface: 'production-deployment-canary',
      os: { name: 'cloudflare-workers', version: 'managed' },
      metadata: { deploymentManifestSha256: value.deploymentManifestSha256 },
    },
    scenario: { feature: 'continuous-assurance-production-deployment', scenario: value.canaryRunId, expectedResult: 'read-only deployed wiring canary passes' },
    artifact: { locator: value.artifactLocator, sha256: value.artifactSha256, expiresAt: new Date(BASE + 86_400_000).toISOString() },
    verification: { verifier: VERIFIER, version: '1.0.0', verifiedAt: new Date(value.capturedAtMs + 1_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'production-deployment-canary-v1' },
    payload: value,
  };
}

function validationOptions(value: EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload>): EvidenceValidationOptions {
  return {
    now: BASE + 60_000,
    trustedVerifiers: [{ name: VERIFIER, version: '1.0.0' }],
    loadArtifact: async () => ARTIFACT,
    verifyArtifact: async () => ({ ...value.verification! }),
  };
}

function expectedFingerprints(value: ContinuousAssuranceProductionDeploymentCanaryPayload) {
  return Object.fromEntries(value.deployments.map((item) => [item.role, item.configFingerprintSha256])) as Record<ContinuousAssuranceDeploymentServiceRole, string>;
}

function gateOptions(value: EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload>) {
  return {
    canaryEvidence: value,
    evidenceValidationOptions: validationOptions(value),
    expectedVerifierName: VERIFIER,
    expectedDeployCommitSha: value.payload.deployCommitSha,
    expectedDeploymentManifestSha256: value.payload.deploymentManifestSha256,
    expectedConfigFingerprints: expectedFingerprints(value.payload),
  };
}

function engineBindings(value: ContinuousAssuranceProductionDeploymentCanaryPayload) {
  return Object.fromEntries(['provider', 'evidence', 'pager'].map((role) => {
    const item = value.deployments.find((deployment) => deployment.role === role)!;
    return [role, {
      service: item.service,
      versionId: item.versionId,
      versionTag: item.versionTag,
      versionTimestamp: item.versionTimestamp,
      configFingerprintSha256: item.configFingerprintSha256,
    }];
  }));
}

describe('continuous assurance production deployment canary gate', () => {
  it('promotes a captured-and-verified read-only deployed wiring canary', async () => {
    const value = envelope();
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate(gateOptions(value));
    expect(report.status).toBe('pass');
    expect(report.promoteHoldThresholds.decision).toBe('promote');
    expect(report.deploymentManifestSha256).toBe(DEPLOYMENT_MANIFEST_SHA);
    expect(report.deployCommitSha).toBe(DEPLOY_COMMIT);
    expect(report.bottlenecksToIssue).toEqual([
      PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_BOTTLENECK,
    ]);
  });

  it('rejects self-reported deployment claims', async () => {
    const value = envelope();
    const selfReported = { ...value, evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed', artifact: undefined, verification: undefined } as EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload>;
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate({
      ...gateOptions(value),
      canaryEvidence: selfReported,
      evidenceValidationOptions: undefined,
    });
    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('production-deployment-canary-evidence-not-production-candidate');
  });

  it('rejects missing or malformed deployed Worker identities', async () => {
    const base = payload();
    const bad = payload({
      deployments: base.deployments.map((item) => item.role === 'engine'
        ? { ...item, versionId: '', configFingerprintSha256: 'bad' }
        : item),
    });
    const value = envelope(bad);
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate(gateOptions(value));
    expect(report.status).toBe('fail');
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-deployment-canary-deployment-invalid:engine');
  });

  it('rejects a canary that performed provider actions instead of remaining idle', async () => {
    const base = payload();
    const bad = payload({
      runtimeResult: {
        ...base.runtimeResult,
        status: 'pass',
        actionIdempotencyKeys: ['cycle-1:provider-audit'],
        latestCycleRunId: 'cycle-1',
        latestAggregateRunId: 'cycle-1-aggregate',
      },
    });
    const value = envelope(bad);
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate(gateOptions(value));
    expect(report.status).toBe('fail');
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-deployment-canary-runtime-not-clean');
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-deployment-canary-read-only-actions-detected');
  });

  it('rejects an incomplete negative-path result', async () => {
    const base = payload();
    const bad = payload({ negativeChecks: { ...base.negativeChecks, digestMismatchRejected: false } });
    const value = envelope(bad);
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate(gateOptions(value));
    expect(report.status).toBe('fail');
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-deployment-canary-negative-check-incomplete');
  });

  it('rejects an evidence envelope that does not match the expected deploy commit or manifest', async () => {
    const value = envelope();
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate({
      ...gateOptions(value),
      expectedDeploymentManifestSha256: '0'.repeat(64),
    });
    expect(report.status).toBe('fail');
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-deployment-canary-deployment-manifest-mismatch');
  });

  it('rejects a role config fingerprint that differs from the operator deployment plan', async () => {
    const value = envelope();
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate({
      ...gateOptions(value),
      expectedConfigFingerprints: {
        ...expectedFingerprints(value.payload),
        provider: '0'.repeat(64),
      },
    });
    expect(report.status).toBe('fail');
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-deployment-canary-deployment-invalid:provider');
  });

  it('independent verifier rejects a correct-digest artifact whose JSON identity differs from the envelope payload', async () => {
    const basePayload = payload();
    const record = {
      schema: 'unzen-continuous-assurance-production-deployment-canary-v1',
      canaryRunId: basePayload.canaryRunId,
      triggerKey: basePayload.triggerKey,
      deployCommitSha: basePayload.deployCommitSha,
      deploymentManifestSha256: '0'.repeat(64),
      deployments: basePayload.deployments,
      engineBindings: engineBindings(basePayload),
      runtimeResult: basePayload.runtimeResult,
      badDispatchSecretRejected: true,
      duplicateCompletedDispatchSuppressed: true,
    };
    const content = JSON.stringify(record);
    const digest = createHash('sha256').update(content).digest('hex');
    const mismatchPayload = payload({ artifactSha256: digest });
    const value = envelope(mismatchPayload) as Extract<EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload>, { evidenceLevel: 'captured-and-verified' }>;
    const response = await handleContinuousAssuranceIndependentVerifierRequest(new Request('https://verifier.internal/verify/artifact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        envelope: value,
        actualSha256: digest,
        artifactContent: { kind: 'utf8', content },
      }),
    }), { verifierName: VERIFIER, verifierVersion: '1.0.0' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'deployment-canary-artifact-identity-mismatch' });
  });
});
