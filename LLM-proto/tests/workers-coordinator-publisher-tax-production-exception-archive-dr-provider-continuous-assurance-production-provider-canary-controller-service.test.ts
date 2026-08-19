import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProductionProviderCanaryController } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-controller-service.js';

const NOW = Date.parse('2026-08-20T04:50:00.000Z');

function selfReportedDeploymentEvidence() {
  return {
    schemaVersion: '1.0.0',
    evidenceKind: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary',
    evidenceLevel: 'self-reported-runtime',
    readinessStatus: 'runtime-observed',
    producer: { name: 'fixture', version: '1.0.0' },
    runId: 'deployment-self-reported',
    capturedAt: new Date(NOW - 1000).toISOString(),
    environment: { runtime: 'test', runtimeVersion: '1', executionSurface: 'test' },
    redaction: { applied: true, policyVersion: 'test' },
    payload: {},
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
      expectedConfigFingerprints: {} as any,
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
