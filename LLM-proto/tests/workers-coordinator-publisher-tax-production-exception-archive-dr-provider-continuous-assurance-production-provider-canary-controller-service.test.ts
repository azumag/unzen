import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProductionProviderCanaryController } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-controller-service.js';

const NOW = Date.parse('2026-08-20T04:50:00.000Z');
const ROLES = ['controller', 'runtime', 'engine', 'provider', 'evidence', 'pager', 'verifier'] as const;
const SERVICES = {
  controller: 'unzen-llm-continuous-assurance-production-canary',
  runtime: 'unzen-llm-continuous-assurance',
  engine: 'unzen-llm-continuous-assurance-engine',
  provider: 'unzen-llm-continuous-assurance-provider-adapter',
  evidence: 'unzen-llm-continuous-assurance-evidence-adapter',
  pager: 'unzen-llm-continuous-assurance-pager-adapter',
  verifier: 'unzen-llm-continuous-assurance-independent-verifier',
} as const;
const FINGERPRINTS = Object.fromEntries(
  ROLES.map((role, index) => [role, String(index + 1).repeat(64).slice(0, 64)]),
) as Record<(typeof ROLES)[number], string>;

function selfReportedDeploymentEvidence() {
  const scheduledTimeMs = NOW - 10_000;
  const triggerKey = `publisher-tax-exception-archive-dr:deployment-canary-idle:${scheduledTimeMs}`;
  const canaryRunId = `production-deployment-canary:${scheduledTimeMs}`;
  return {
    schemaVersion: '1.0.0',
    evidenceKind: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary',
    evidenceLevel: 'self-reported-runtime',
    readinessStatus: 'runtime-observed',
    producer: { name: 'fixture', version: '1.0.0' },
    runId: canaryRunId,
    capturedAt: new Date(scheduledTimeMs + 2).toISOString(),
    environment: { runtime: 'test', runtimeVersion: '1', executionSurface: 'test' },
    redaction: { applied: true, policyVersion: 'test' },
    payload: {
      scope: 'publisher-tax-exception-archive-dr',
      cron: 'deployment-canary-idle',
      scheduledTimeMs,
      triggerKey,
      canaryRunId,
      startedAtMs: scheduledTimeMs,
      completedAtMs: scheduledTimeMs + 2,
      deployCommitSha: 'a'.repeat(40),
      deploymentManifestSha256: 'b'.repeat(64),
      deployments: ROLES.map((role, index) => ({
        role,
        service: SERVICES[role],
        versionId: `version-${role}-${index}-12345678`,
        versionTag: `tag-${index}`,
        versionTimestamp: new Date(scheduledTimeMs - 1000).toISOString(),
        configFingerprintSha256: FINGERPRINTS[role],
      })),
      runtimeResult: {
        status: 'idle',
        triggerKey,
        cycleId: 'schedule-1:next',
        failureReason: null,
        actionIdempotencyKeys: [],
        latestCycleRunId: null,
        latestAggregateRunId: null,
        runtimeDelivery: { durableState: 'completed', replayCount: 0, replayed: false },
      },
      artifactLocator: 'self-reported://deployment-canary',
      artifactSha256: 'c'.repeat(64),
      verificationId: 'self-reported-verification-id',
      verifier: 'unzen-independent-evidence-verifier',
      verifierVersion: '1.0.0',
      negativeChecks: {
        badDispatchSecretRejected: true,
        duplicateCompletedDispatchSuppressed: true,
        versionOrConfigMismatchRejected: true,
        digestMismatchRejected: true,
        untrustedVerifierRejected: true,
      },
      capturedAtMs: scheduledTimeMs + 2,
    },
  } as any;
}

describe('production provider canary controller service', () => {
  it('does not touch provider or pager bindings when upstream deployed evidence is not independently verified', async () => {
    let providerCalls = 0;
    let pagerCalls = 0;
    await expect(runProductionProviderCanaryController({
      canaryRunId: 'provider-canary-preflight',
      nowMs: NOW,
      deploymentCanaryEvidence: selfReportedDeploymentEvidence(),
      deploymentEvidenceValidationOptions: { now: NOW },
      expectedDeployCommitSha: 'a'.repeat(40),
      expectedDeploymentManifestSha256: 'b'.repeat(64),
      expectedConfigFingerprints: FINGERPRINTS,
      expectedDeploymentVerifierName: 'unzen-independent-evidence-verifier',
      authorization: {} as any,
      bindings: {
        provider: { async fetch() { providerCalls += 1; return new Response(); } },
        pager: { async fetch() { pagerCalls += 1; return new Response(); } },
      },
      verifier: { async fetch() { throw new Error('verifier must not be called'); } },
      bucket: { async put() { throw new Error('bucket must not be called'); } },
      verifierName: 'unzen-production-provider-canary-verifier',
      verifierVersion: '1.0.0',
      producerName: 'controller', producerVersion: '1.0.0', producerCommitSha: 'a'.repeat(40),
      retentionMs: 1000, onCallRoute: 'route', escalationTarget: 'target',
    })).rejects.toThrow('production-provider-canary-upstream-deployment-invalid');
    expect(providerCalls).toBe(0);
    expect(pagerCalls).toBe(0);
  });

  it('keeps provider canary controller/verifier Workers internal-only and operator-triggered', async () => {
    const root = decodeURIComponent(new URL('../worker-runtime', import.meta.url).pathname);
    const [controller, verifier] = await Promise.all([
      readFile(join(root, 'wrangler.production-provider-canary.jsonc'), 'utf8'),
      readFile(join(root, 'wrangler.production-provider-canary-verifier.jsonc'), 'utf8'),
    ]);
    for (const config of [controller, verifier]) {
      expect(config).toContain('"workers_dev": false');
      expect(config).toContain('"preview_urls": false');
      expect(config).not.toContain('"routes"');
    }
    expect(controller).not.toContain('"crons"');
    expect(controller).toContain('"PROVIDER_ADAPTER"');
    expect(controller).toContain('"PAGER_ADAPTER"');
    expect(controller).toContain('"EVIDENCE_ADAPTER"');
    expect(controller).toContain('"PROVIDER_CANARY_VERIFIER"');
    expect(controller).toContain('"required": ["PROVIDER_CANARY_CONTROLLER_SECRET"]');
  });
});
