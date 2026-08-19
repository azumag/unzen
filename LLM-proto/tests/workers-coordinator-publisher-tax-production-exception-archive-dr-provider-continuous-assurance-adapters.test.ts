import { describe, expect, it } from 'vitest';
import {
  handleContinuousAssuranceEvidenceAdapterRequest,
  handleContinuousAssurancePagerAdapterRequest,
  handleContinuousAssuranceProviderAdapterRequest,
  type ContinuousAssuranceR2Bucket,
  type ContinuousAssuranceR2ObjectBody,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.js';
import { handleContinuousAssuranceIndependentVerifierRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-independent-verifier.js';

const BASE = Date.parse('2026-08-20T00:00:00.000Z');
const DIGEST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VERIFIER = { verifierName: 'unzen-independent-evidence-verifier', verifierVersion: '1.0.0' };

class MemoryR2 implements ContinuousAssuranceR2Bucket {
  readonly objects = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>();

  async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { readonly customMetadata?: Record<string, string> }) {
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    this.objects.set(key, { bytes, customMetadata: options?.customMetadata });
  }

  async get(key: string): Promise<ContinuousAssuranceR2ObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      size: object.bytes.byteLength,
      customMetadata: object.customMetadata,
      arrayBuffer: async () => object.bytes.slice().buffer,
    };
  }
}

function verifierBinding() {
  return { fetch: (request: Request) => handleContinuousAssuranceIndependentVerifierRequest(request, VERIFIER) };
}

function actionContext(action: string, key: string) {
  return {
    cycleId: 'cycle-4', scheduledAtMs: BASE, nowMs: BASE + 1_000, action,
    idempotencyKey: key, attempt: 1, backoffMsBeforeAttempt: 0,
  } as never;
}

function adapterRequest(path: string, body: unknown, key?: string) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key) headers.set('x-unzen-idempotency-key', key);
  return new Request(`https://adapter.internal${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function cycleDraft() {
  return {
    providerName: 'provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1',
    replicaSiteId: 'replica-1', replicaRegion: 'ap-northeast-1', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    cycleId: 'cycle-4', scheduleId: 'schedule-1', scheduledAtMs: BASE, startedAtMs: BASE + 1_000, completedAtMs: BASE + 20_000,
    auditStreamId: 'audit-1', auditCursorStart: 'a', auditCursorEnd: 'b', providerAuditRecordIds: ['record-1'],
    primaryRetrieval: { retrievalOperationId: 'primary-read-1', storageId: 'primary-1', archiveId: 'archive-1', requestedAtMs: BASE + 2_000, completedAtMs: BASE + 3_000, observedContentDigest: DIGEST, integrityCheckId: 'primary-check-1', integrityStatus: 'pass' },
    backupRetrieval: { retrievalOperationId: 'backup-read-1', storageId: 'backup-1', archiveId: 'archive-1', requestedAtMs: BASE + 4_000, completedAtMs: BASE + 5_000, observedContentDigest: DIGEST, integrityCheckId: 'backup-check-1', integrityStatus: 'pass' },
    operationCount: 100, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityPct: 99.99,
    observedCredentialSetId: 'cred-1', observedSigningKeyId: 'sign-1', observedEncryptionKeyId: 'enc-1',
    alertDispositions: [], incidentReviews: [], rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', rollbackArmed: true, emergencyHoldArmed: true, controlInvocations: [],
    baselineIncidentIds: [], recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', retentionPolicySnapshot: {},
    allowedOrigins: ['https://coordinator.unzen.dev'], cspConnectSrc: ['https://coordinator.unzen.dev'], sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [],
  };
}

function evidenceOptions(bucket: MemoryR2) {
  return {
    bucket, verifier: verifierBinding(), producerName: 'unzen-continuous-assurance-evidence-adapter', producerVersion: '1.0.0',
    producerCommitSha: '0123456789abcdef0123456789abcdef01234567', verifierName: VERIFIER.verifierName,
    verifierVersion: VERIFIER.verifierVersion, defaultRetentionMs: 86_400_000,
  };
}

describe('continuous assurance adapter runtimes', () => {
  it('preserves provider idempotency and maps upstream failure closed', async () => {
    let observedKey: string | null = null;
    const key = 'cycle-4:provider-audit';
    const response = await handleContinuousAssuranceProviderAdapterRequest(
      adapterRequest('/provider/audit', { context: actionContext('provider-audit', key) }, key),
      {
        apiBaseUrl: 'https://provider.example/api', apiToken: 'x',
        fetcher: async (input) => {
          observedKey = input.headers.get('x-unzen-idempotency-key');
          return Response.json({ auditStreamId: 'audit-1', auditCursorStart: 'a', auditCursorEnd: 'b', providerAuditRecordIds: [], observedAtMs: BASE + 1_000 });
        },
      },
    );
    expect(response.status).toBe(200);
    expect(observedKey).toBe(key);

    const failed = await handleContinuousAssuranceProviderAdapterRequest(
      adapterRequest('/provider/audit', {}, key),
      { apiBaseUrl: 'https://provider.example', apiToken: 'x', fetcher: async () => Response.json({}, { status: 503 }) },
    );
    expect(failed.status).toBe(503);
  });

  it('archives, captures, loads and independently re-verifies cycle evidence', async () => {
    const bucket = new MemoryR2();
    const archiveKey = 'cycle-4:cycle-evidence-archive';
    const archived = await handleContinuousAssuranceEvidenceAdapterRequest(
      adapterRequest('/evidence/cycle/archive', { draft: cycleDraft(), minimumRetentionMs: 86_400_000, context: actionContext('cycle-evidence-archive', archiveKey) }, archiveKey),
      evidenceOptions(bucket),
    );
    expect(archived.status).toBe(200);
    const retained = await archived.json() as any;
    expect(retained.evidenceContentDigest).toMatch(/^[a-f0-9]{64}$/);

    const payload = { ...cycleDraft(), retainedEvidence: retained, capturedAtMs: BASE + 21_000 };
    const captureKey = 'cycle-4:cycle-evidence-capture';
    const captured = await handleContinuousAssuranceEvidenceAdapterRequest(
      adapterRequest('/evidence/cycle/capture', { payload, context: actionContext('cycle-evidence-capture', captureKey) }, captureKey),
      evidenceOptions(bucket),
    );
    expect(captured.status).toBe(200);
    const envelope = await captured.json() as any;
    expect(envelope.evidenceLevel).toBe('captured-and-verified');
    expect(envelope.readinessStatus).toBe('production-approved');
    expect(envelope.artifact.sha256).toBe(retained.evidenceContentDigest);

    const loaded = await handleContinuousAssuranceEvidenceAdapterRequest(
      adapterRequest('/evidence/artifact/load', { locator: envelope.artifact.locator }), evidenceOptions(bucket),
    );
    const artifactContent = await loaded.json();
    const verified = await handleContinuousAssuranceEvidenceAdapterRequest(
      adapterRequest('/evidence/artifact/verify', { envelope, actualSha256: envelope.artifact.sha256, artifactContent }),
      evidenceOptions(bucket),
    );
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ verifier: VERIFIER.verifierName, result: 'pass' });
  });

  it('rejects retained-artifact digest tampering', async () => {
    const bucket = new MemoryR2();
    const archiveKey = 'cycle-4:cycle-evidence-archive';
    const archived = await handleContinuousAssuranceEvidenceAdapterRequest(
      adapterRequest('/evidence/cycle/archive', { draft: cycleDraft(), minimumRetentionMs: 86_400_000, context: actionContext('cycle-evidence-archive', archiveKey) }, archiveKey),
      evidenceOptions(bucket),
    );
    const retained = await archived.json() as any;
    bucket.objects.set(retained.evidenceArchiveId, { bytes: new TextEncoder().encode('tampered'), customMetadata: { sha256: retained.evidenceContentDigest } });
    const captureKey = 'cycle-4:cycle-evidence-capture';
    const response = await handleContinuousAssuranceEvidenceAdapterRequest(
      adapterRequest('/evidence/cycle/capture', { payload: { ...cycleDraft(), retainedEvidence: retained, capturedAtMs: BASE + 21_000 }, context: actionContext('cycle-evidence-capture', captureKey) }, captureKey),
      evidenceOptions(bucket),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'evidence-artifact-digest-mismatch' });
  });

  it('preserves pager dedupe and treats an upstream duplicate as successful suppression', async () => {
    const key = 'cycle-4:page:provider-down';
    let observedKey: string | null = null;
    const response = await handleContinuousAssurancePagerAdapterRequest(
      adapterRequest('/page', { dedupeKey: key, cycleId: 'cycle-4', reason: 'provider-down', nowMs: BASE, onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead' }, key),
      {
        apiUrl: 'https://pager.example/events', apiToken: 'x',
        fetcher: async (input) => { observedKey = input.headers.get('idempotency-key'); return Response.json({}, { status: 409 }); },
      },
    );
    expect(response.status).toBe(200);
    expect(observedKey).toBe(key);
    expect(await response.json()).toMatchObject({ status: 'deduplicated', attempts: 1 });
  });
});
