import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runProductionProviderCanary } from '../worker-runtime/continuous-assurance-production-provider-canary-worker.mjs';
import verifierWorker from '../worker-runtime/continuous-assurance-independent-verifier-provider-canary-wrapper.mjs';

const NOW = Date.now();
const VERIFIER = 'unzen-independent-evidence-verifier';
const CONFIG = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const DEPLOY_RUN = `production-deployment-canary:${NOW - 60_000}`;
const STEADY_RUN = 'steady-runtime-aggregate';

function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function metadata(service: string, role: string) {
  return {
    role,
    service,
    versionId: `version-${role}-12345678`,
    versionTag: `tag-${role}`,
    versionTimestamp: new Date(NOW - 120_000).toISOString(),
    configFingerprintSha256: CONFIG,
  };
}

const deployments = [
  metadata('unzen-llm-continuous-assurance-production-canary', 'controller'),
  metadata('unzen-llm-continuous-assurance', 'runtime'),
  metadata('unzen-llm-continuous-assurance-engine', 'engine'),
  metadata('unzen-llm-continuous-assurance-provider-adapter', 'provider'),
  metadata('unzen-llm-continuous-assurance-evidence-adapter', 'evidence'),
  metadata('unzen-llm-continuous-assurance-pager-adapter', 'pager'),
  metadata('unzen-llm-continuous-assurance-independent-verifier', 'verifier'),
];

function captured(kind: string, runId: string, readinessStatus: 'production-candidate' | 'production-approved', payload: any, artifactText: string) {
  const digest = sha(artifactText);
  const locator = `r2://continuous-assurance-evidence/${encodeURIComponent(`fixtures/${runId}/${digest}.json`)}`;
  return {
    schemaVersion: '1.0.0', evidenceKind: kind, evidenceLevel: 'captured-and-verified', readinessStatus,
    producer: { name: 'fixture-producer', version: '1.0.0', commitSha: '1'.repeat(40) },
    runId, capturedAt: new Date(NOW - 5_000).toISOString(),
    environment: { runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'fixture', os: { name: 'cloudflare-workers', version: 'managed' } },
    scenario: { feature: kind, scenario: runId, expectedResult: 'pass' },
    artifact: { locator, sha256: digest, expiresAt: new Date(NOW + 86_400_000).toISOString() },
    verification: { verifier: VERIFIER, version: '1.0.0', verifiedAt: new Date(NOW - 4_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'fixture-v1' }, payload,
  };
}

function deploymentEvidence() {
  return captured(
    'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary',
    DEPLOY_RUN,
    'production-candidate',
    { deployments },
    'deployment-fixture-artifact',
  );
}

function steadyPayload() {
  return {
    providerName: 'provider-a', accountId: 'account-a', primaryStorageId: 'primary-a', backupStorageId: 'backup-a',
    replicaSiteId: 'replica-a', replicaRegion: 'region-a', archiveId: 'archive-a', archiveContentDigest: DIGEST,
    cycleRunIds: ['c1', 'c2', 'c3'],
    schedule: { nextDueAtMs: NOW + 60_000 },
    rollingSlo: { requiredProviderAvailabilityPct: 99 },
    credentialRotation: { currentCredentialSetId: 'cred-a', currentSigningKeyId: 'sign-a', currentEncryptionKeyId: 'enc-a' },
    rollbackControlId: 'rollback-a', emergencyHoldControlId: 'hold-a',
    onCallRoute: 'normal-on-call', escalationTarget: 'normal-escalation',
    capturedAtMs: NOW - 2_000,
  };
}

function steadyEvidence() {
  return captured(
    'publisher-tax-filing-production-exception-archive-dr-provider-steady-state-operations',
    STEADY_RUN,
    'production-approved',
    steadyPayload(),
    'steady-fixture-artifact',
  );
}

function binding(handler: (request: Request) => Promise<Response> | Response) {
  return { fetch: handler };
}

function bytesObject(value: string) {
  const bytes = new TextEncoder().encode(value);
  return {
    size: bytes.byteLength,
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const deployment = deploymentEvidence();
  const steady = steadyEvidence();
  const artifactByLocator = new Map<string, string>([
    [deployment.artifact.locator, 'deployment-fixture-artifact'],
    [steady.artifact.locator, 'steady-fixture-artifact'],
  ]);
  const r2 = new Map<string, string>();
  const providerPaths: string[] = [];
  let pagerCalls = 0;
  const providerIdentity = {
    providerName: 'provider-a', accountId: 'account-a', primaryStorageId: 'primary-a', backupStorageId: 'backup-a',
    replicaSiteId: 'replica-a', replicaRegion: 'region-a', archiveId: 'archive-a', archiveContentDigest: DIGEST,
    credentialSetId: 'cred-a', signingKeyId: 'sign-a', encryptionKeyId: 'enc-a',
    normalOnCallRoute: 'normal-on-call', normalEscalationTarget: 'normal-escalation',
  };

  const metaBindings = Object.fromEntries(deployments.map((item) => [item.role, binding(() => Response.json({
    service: item.service, versionId: item.versionId, versionTag: item.versionTag,
    versionTimestamp: item.versionTimestamp, configFingerprintSha256: item.configFingerprintSha256,
  }))]));

  const evidenceAdapter = binding(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/__meta') return (metaBindings.evidence as any).fetch(request);
    const body = await request.json() as any;
    if (url.pathname === '/evidence/artifact/load') {
      const text = artifactByLocator.get(body.locator);
      if (text === undefined) return Response.json({ error: 'not-found' }, { status: 404 });
      return Response.json({ kind: 'bytes', bytes: Array.from(new TextEncoder().encode(text)) });
    }
    if (url.pathname === '/evidence/artifact/verify') {
      return Response.json({ ...body.envelope.verification });
    }
    return new Response('not found', { status: 404 });
  });

  const providerAdapter = binding(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/__meta') return (metaBindings.provider as any).fetch(request);
    providerPaths.push(url.pathname);
    const idempotency = request.headers.get('x-unzen-idempotency-key');
    if (!idempotency) return Response.json({ error: 'idempotency-key-required' }, { status: 400 });
    if (url.pathname === '/provider/canary-unsupported') return Response.json({ error: 'not-found' }, { status: 404 });
    const body = await request.json() as any;
    if (url.pathname === '/provider/audit') {
      return Response.json({ auditStreamId: 'audit-stream', auditCursorStart: 'cursor-a', auditCursorEnd: 'cursor-b', providerAuditRecordIds: ['record-1'], observedAtMs: NOW });
    }
    if (url.pathname === '/provider/archive/retrieve') {
      return Response.json({ retrievalOperationId: `retrieve-${body.role}`, storageId: body.storageId, archiveId: body.archiveId, requestedAtMs: NOW, completedAtMs: NOW, observedContentDigest: body.expectedDigest, integrityCheckId: `integrity-${body.role}`, integrityStatus: 'pass' });
    }
    if (url.pathname === '/provider/health') {
      return Response.json({
        observedAtMs: NOW, operationCount: 4, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityPct: 100,
        observedCredentialSetId: 'cred-a', observedSigningKeyId: 'sign-a', observedEncryptionKeyId: 'enc-a',
        alertDispositions: [], incidentReviews: [], rollbackControlId: 'rollback-a', emergencyHoldControlId: 'hold-a', rollbackArmed: true, emergencyHoldArmed: true,
        controlInvocations: [], allowedOrigins: [], cspConnectSrc: [], sandboxFlags: [], coop: null, coep: null, networkAttempts: [],
      });
    }
    return new Response('not found', { status: 404 });
  });

  const pagerAdapter = binding(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/__meta') return (metaBindings.pager as any).fetch(request);
    pagerCalls += 1;
    if (pagerCalls === 1) return Response.json({ status: 'accepted', deliveryId: 'canary-delivery', attempts: 1 });
    return Response.json({ status: 'deduplicated', attempts: 1 });
  });

  const verifierEnv = {
    VERIFIER_NAME: VERIFIER, VERIFIER_VERSION: '1.0.0',
    CF_VERSION_METADATA: {}, CONFIG_FINGERPRINT_SHA256: CONFIG,
  };
  const independentVerifier = binding((request) => {
    if (new URL(request.url).pathname === '/__meta') return (metaBindings.verifier as any).fetch(request);
    return verifierWorker.fetch(request, verifierEnv as any, {} as any);
  });

  const engine = binding((request) => {
    const url = new URL(request.url);
    if (url.pathname === '/__meta') return (metaBindings.engine as any).fetch(request);
    if (url.pathname === '/__canary/state') {
      return Response.json({ currentRunId: STEADY_RUN, steadyStateOperationsEvidence: steady, providerIdentity });
    }
    return new Response('not found', { status: 404 });
  });

  const env = {
    CONTINUOUS_ASSURANCE_SCOPE: 'publisher-tax-exception-archive-dr',
    CANARY_DISPATCH_SECRET: 'dispatch-secret',
    PROVIDER_CANARY_CONTROLLER_SECRET: 'controller-secret',
    CANARY_PAGER_ROUTE: 'provider-canary-route',
    CANARY_PAGER_TARGET: 'provider-canary-target',
    TRUSTED_VERIFIER_NAME: VERIFIER,
    CANARY_RETENTION_MS: '2592000000',
    DEPLOY_COMMIT_SHA: '2'.repeat(40),
    CONFIG_FINGERPRINT_SHA256: CONFIG,
    CF_VERSION_METADATA: { id: 'provider-canary-version-12345678', tag: 'provider-canary', timestamp: new Date(NOW - 60_000).toISOString() },
    PRODUCTION_DEPLOYMENT_CANARY: metaBindings.controller,
    CONTINUOUS_ASSURANCE_RUNTIME: metaBindings.runtime,
    ASSURANCE_ENGINE: engine,
    PROVIDER_ADAPTER: providerAdapter,
    EVIDENCE_ADAPTER: evidenceAdapter,
    PAGER_ADAPTER: pagerAdapter,
    INDEPENDENT_VERIFIER: independentVerifier,
    CANARY_EVIDENCE_BUCKET: {
      async put(key: string, value: unknown) { r2.set(key, typeof value === 'string' ? value : String(value)); },
      async get(key: string) { const value = r2.get(key); return value === undefined ? null : bytesObject(value); },
    },
    ...overrides,
  };
  return { env, deployment, r2, providerPaths, getPagerCalls: () => pagerCalls };
}

describe('continuous assurance production provider canary controller', () => {
  it('runs only bounded read-only provider operations and a duplicate-safe canary pager', async () => {
    const { env, deployment, r2, providerPaths, getPagerCalls } = makeEnv();
    const envelope = await runProductionProviderCanary({ deploymentCanaryEvidence: deployment, nowMs: NOW }, env as any);
    expect(envelope.evidenceLevel).toBe('captured-and-verified');
    expect(envelope.readinessStatus).toBe('production-candidate');
    expect(envelope.payload.forbiddenActionAttempts).toEqual([]);
    expect(envelope.payload.pager.duplicateStatus).toBe('deduplicated');
    expect(providerPaths).toEqual([
      '/provider/audit',
      '/provider/canary-unsupported',
      '/provider/audit',
      '/provider/archive/retrieve',
      '/provider/archive/retrieve',
      '/provider/health',
    ]);
    expect(providerPaths).not.toContain('/provider/keys/rotate');
    expect(providerPaths).not.toContain('/provider/dr/exercise');
    expect(getPagerCalls()).toBe(2);
    expect(r2.has('provider-canary/latest-envelope.json')).toBe(true);
  });

  it('fails before provider actions when a deployed service version drifts', async () => {
    const base = makeEnv();
    const drifted = binding(() => Response.json({
      service: 'unzen-llm-continuous-assurance-provider-adapter', versionId: 'version-provider-drifted', versionTag: 'drift',
      versionTimestamp: new Date(NOW - 120_000).toISOString(), configFingerprintSha256: CONFIG,
    }));
    const { env, providerPaths } = makeEnv({ PROVIDER_ADAPTER: drifted });
    await expect(runProductionProviderCanary({ deploymentCanaryEvidence: base.deployment, nowMs: NOW }, env as any))
      .rejects.toThrow('production-provider-canary-deployment-drift');
    expect(providerPaths).toEqual([]);
  });

  it('rejects use of the normal production escalation destination', async () => {
    const { env, deployment } = makeEnv({ CANARY_PAGER_ROUTE: 'normal-on-call' });
    await expect(runProductionProviderCanary({ deploymentCanaryEvidence: deployment, nowMs: NOW }, env as any))
      .rejects.toThrow('production-provider-canary-pager-destination-not-isolated');
  });

  it('returns the stored envelope for the same deployment + steady-state run without reissuing provider or pager calls', async () => {
    const { env, deployment, providerPaths, getPagerCalls } = makeEnv();
    const first = await runProductionProviderCanary({ deploymentCanaryEvidence: deployment, nowMs: NOW }, env as any);
    const providerCalls = providerPaths.length;
    const pagerCalls = getPagerCalls();
    const second = await runProductionProviderCanary({ deploymentCanaryEvidence: deployment, nowMs: NOW + 1 }, env as any);
    expect(second.runId).toBe(first.runId);
    expect(providerPaths).toHaveLength(providerCalls);
    expect(getPagerCalls()).toBe(pagerCalls);
  });

  it('keeps the production provider canary internal and disabled by default', async () => {
    const configPath = decodeURIComponent(new URL('../worker-runtime/wrangler.production-provider-canary.jsonc', import.meta.url).pathname);
    const config = await readFile(configPath, 'utf8');
    expect(config).toContain('"workers_dev": false');
    expect(config).toContain('"preview_urls": false');
    expect(config).toContain('"PROVIDER_CANARY_ENABLED": "false"');
    expect(config).toContain('"CANARY_PAGER_ROUTE": "SET_BY_DEPLOY_PIPELINE"');
    expect(config).toContain('"CANARY_PAGER_TARGET": "SET_BY_DEPLOY_PIPELINE"');
    expect(config).not.toContain('/provider/keys/rotate');
    expect(config).not.toContain('/provider/dr/exercise');
  });
});
