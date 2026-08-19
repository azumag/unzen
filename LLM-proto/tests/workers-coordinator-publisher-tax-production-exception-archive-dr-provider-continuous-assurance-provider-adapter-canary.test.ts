import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope, EvidenceValidationOptions } from '../src/evidence.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_ADAPTER_CANARY_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_BOTTLENECK,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAdapterCanaryGate,
  type ContinuousAssuranceAdapterCanaryAction,
  type ContinuousAssuranceAdapterCanaryPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-provider-adapter-canary.js';
import {
  CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE,
  CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE,
  CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE,
  CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.js';

const BASE = Date.parse('2026-08-20T01:00:00.000Z');
const ARTIFACT = 'verified adapter canary artifact';
const ARTIFACT_SHA = '1467452b0c6a2e33873fa396c5f26d4ee8fd472803f1b52b2fc31b3530865316';
const VERIFIER = 'unzen-independent-evidence-verifier';

const requiredActions: readonly ContinuousAssuranceAdapterCanaryAction[] = [
  'provider-audit', 'primary-archive-retrieval', 'backup-archive-retrieval', 'provider-health',
  'evidence-cycle-archive', 'evidence-cycle-capture', 'evidence-artifact-load', 'evidence-artifact-verify', 'pager-page',
];

function payload(overrides: Partial<ContinuousAssuranceAdapterCanaryPayload> = {}): ContinuousAssuranceAdapterCanaryPayload {
  const scope = 'publisher-tax-exception-archive-dr';
  const cron = '*/5 * * * *';
  const scheduledTimeMs = BASE;
  const startedAtMs = BASE + 1_000;
  const completedAtMs = BASE + 20_000;
  const pagerDedupeKey = 'canary-cycle:page:adapter-canary';
  return {
    scope, cron, scheduledTimeMs, triggerKey: `${scope}:${cron}:${scheduledTimeMs}`,
    canaryRunId: 'adapter-canary-1',
    engineService: 'unzen-llm-continuous-assurance-engine',
    providerAdapterService: CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE,
    evidenceAdapterService: CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE,
    pagerAdapterService: CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE,
    independentVerifierService: CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE,
    configFingerprintSha256: 'b'.repeat(64),
    startedAtMs, completedAtMs,
    receipts: requiredActions.map((action, index) => ({
      adapter: action.startsWith('provider') || action.includes('archive-retrieval')
        ? 'provider'
        : action.startsWith('evidence') ? 'evidence' : 'pager',
      action,
      requestId: `request-${index + 1}`,
      path: `/${action}`,
      idempotencyKey: action === 'pager-page' ? pagerDedupeKey : `canary-cycle:${action}`,
      idempotencyPreserved: true,
      status: 'success',
      observedAtMs: startedAtMs + index * 1_000,
    })),
    artifactLocator: 'r2://continuous-assurance-evidence/canary%2Fartifact.json',
    artifactSha256: ARTIFACT_SHA,
    verifier: VERIFIER,
    verifierVersion: '1.0.0',
    verificationId: 'verification-1',
    pagerDedupeKey,
    negativeChecks: {
      missingIdempotencyRejected: true,
      providerFailureRejected: true,
      digestMismatchRejected: true,
      verifierFailureRejected: true,
      pagerDuplicateSuppressed: true,
    },
    ...overrides,
  };
}

function capturedEnvelope(value = payload()): EvidenceEnvelope<ContinuousAssuranceAdapterCanaryPayload> {
  return {
    schemaVersion: '1.0.0',
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_ADAPTER_CANARY_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: { name: 'adapter-canary-harness', version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
    runId: value.canaryRunId,
    capturedAt: new Date(value.completedAtMs).toISOString(),
    environment: { runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'adapter-canary', os: { name: 'cloudflare-workers', version: 'managed' } },
    scenario: { feature: 'continuous-assurance-adapters', scenario: value.canaryRunId, expectedResult: 'controlled adapter canary passes' },
    artifact: { locator: value.artifactLocator, sha256: ARTIFACT_SHA, expiresAt: '2026-08-21T01:00:00.000Z' },
    verification: { verifier: VERIFIER, version: '1.0.0', verifiedAt: new Date(value.completedAtMs + 1_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'adapter-canary-v1' },
    payload: value,
  };
}

function validationOptions(envelope: EvidenceEnvelope<ContinuousAssuranceAdapterCanaryPayload>): EvidenceValidationOptions {
  return {
    now: BASE + 60_000,
    trustedVerifiers: [{ name: VERIFIER, version: '1.0.0' }],
    loadArtifact: async () => ARTIFACT,
    verifyArtifact: async () => ({ ...envelope.verification! }),
  };
}

describe('continuous assurance provider adapter canary gate', () => {
  it('promotes only an independently verified production-candidate canary', async () => {
    const envelope = capturedEnvelope();
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAdapterCanaryGate({
      canaryEvidence: envelope,
      evidenceValidationOptions: validationOptions(envelope),
      expectedVerifierName: VERIFIER,
    });
    expect(report.status).toBe('pass');
    expect(report.promoteHoldThresholds.decision).toBe('promote');
    expect(report.bottlenecksToIssue).toEqual([
      PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_BOTTLENECK,
    ]);
  });

  it('holds when a required negative-path check is absent', async () => {
    const value = payload({ negativeChecks: { ...payload().negativeChecks, digestMismatchRejected: false } });
    const envelope = capturedEnvelope(value);
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAdapterCanaryGate({
      canaryEvidence: envelope,
      evidenceValidationOptions: validationOptions(envelope),
    });
    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('adapter-canary-negative-check-incomplete');
  });

  it('rejects self-reported runtime claims even when payload fields look production-ready', async () => {
    const value = payload();
    const envelope = {
      schemaVersion: '1.0.0', evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_ADAPTER_CANARY_EVIDENCE_KIND,
      evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed', producer: { name: 'adapter-canary', version: '1.0.0' },
      runId: value.canaryRunId, capturedAt: new Date(value.completedAtMs).toISOString(),
      environment: { runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'adapter-canary' },
      redaction: { applied: true, policyVersion: 'adapter-canary-v1' }, payload: value,
    } as EvidenceEnvelope<ContinuousAssuranceAdapterCanaryPayload>;
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAdapterCanaryGate({ canaryEvidence: envelope });
    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('adapter-canary-evidence-not-production-candidate');
  });

  it('keeps adapter production configs internal-only, binding-aligned, and secret-value free', async () => {
    const projectRoot = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const engine = await readFile(join(projectRoot, 'worker-runtime', 'wrangler.engine.jsonc'), 'utf8');
    const provider = await readFile(join(projectRoot, 'worker-runtime', 'wrangler.provider-adapter.jsonc'), 'utf8');
    const evidence = await readFile(join(projectRoot, 'worker-runtime', 'wrangler.evidence-adapter.jsonc'), 'utf8');
    const pager = await readFile(join(projectRoot, 'worker-runtime', 'wrangler.pager-adapter.jsonc'), 'utf8');
    const verifier = await readFile(join(projectRoot, 'worker-runtime', 'wrangler.independent-verifier.jsonc'), 'utf8');

    for (const config of [provider, evidence, pager, verifier]) {
      expect(config).toContain('"compatibility_date": "2026-08-20"');
      expect(config).toContain('"workers_dev": false');
      expect(config).not.toContain('"routes"');
    }
    expect(engine).toContain(`"service": "${CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE}"`);
    expect(engine).toContain(`"service": "${CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE}"`);
    expect(engine).toContain(`"service": "${CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE}"`);
    expect(evidence).toContain(`"service": "${CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE}"`);
    expect(provider).toContain('"required": ["PROVIDER_API_TOKEN"]');
    expect(pager).toContain('"required": ["PAGER_API_TOKEN"]');
    expect(provider).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{8,}/);
    expect(pager).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{8,}/);
  });
});
