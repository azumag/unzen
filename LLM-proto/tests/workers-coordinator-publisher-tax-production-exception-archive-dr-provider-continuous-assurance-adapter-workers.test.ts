import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const BASE = Date.parse('2026-08-20T02:00:00.000Z');
const DIGEST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VERIFIER_NAME = 'unzen-independent-evidence-verifier';
const VERIFIER_VERSION = '1.0.0';

function actionContext(action: string, key: string) {
  return {
    cycleId: 'cycle-miniflare-1', scheduledAtMs: BASE, nowMs: BASE + 1_000,
    action, idempotencyKey: key, attempt: 1, backoffMsBeforeAttempt: 0,
  };
}

function cycleDraft() {
  return {
    providerName: 'provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1',
    replicaSiteId: 'replica-1', replicaRegion: 'ap-northeast-1', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    cycleId: 'cycle-miniflare-1', scheduleId: 'schedule-1', scheduledAtMs: BASE, startedAtMs: BASE + 1_000, completedAtMs: BASE + 20_000,
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

async function withRuntime<T>(run: (mf: Miniflare, persistRoot: string, buildRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'unzen-assurance-adapters-'));
  const buildRoot = join(root, 'build');
  const persistRoot = join(root, 'r2');
  try {
    await compileWorkers(buildRoot);
    const mf = createMiniflare(buildRoot, persistRoot);
    try {
      return await run(mf, persistRoot, buildRoot);
    } finally {
      await mf.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createMiniflare(buildRoot: string, persistRoot: string): Miniflare {
  return new Miniflare({
    modulesRoot: buildRoot,
    r2Persist: persistRoot,
    workers: [
      {
        name: 'evidence-adapter',
        modules: true,
        modulesRoot: buildRoot,
        modulesRules: [{ type: 'ESModule', include: ['**/*.js'], fallthrough: true }],
        scriptPath: join(buildRoot, 'worker-runtime', 'continuous-assurance-evidence-adapter-worker.mjs'),
        routes: ['http://evidence.mf/*'],
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          EVIDENCE_PRODUCER_NAME: 'unzen-continuous-assurance-evidence-adapter',
          EVIDENCE_PRODUCER_VERSION: '1.0.0',
          EVIDENCE_PRODUCER_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
          TRUSTED_VERIFIER_NAME: VERIFIER_NAME,
          TRUSTED_VERIFIER_VERSION: VERIFIER_VERSION,
          EVIDENCE_DEFAULT_RETENTION_MS: '86400000',
        },
        r2Buckets: { EVIDENCE_BUCKET: 'continuous-assurance-evidence-test' },
        serviceBindings: { INDEPENDENT_VERIFIER: 'independent-verifier' },
      },
      {
        name: 'independent-verifier',
        modules: true,
        modulesRoot: buildRoot,
        modulesRules: [{ type: 'ESModule', include: ['**/*.js'], fallthrough: true }],
        scriptPath: join(buildRoot, 'worker-runtime', 'continuous-assurance-independent-verifier-worker.mjs'),
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: { VERIFIER_NAME, VERIFIER_VERSION },
      },
    ],
  });
}

async function compileWorkers(buildRoot: string): Promise<void> {
  const projectRoot = decodeURIComponent(new URL('..', import.meta.url).pathname);
  const sourceRoot = join(projectRoot, 'src');
  const sourceFiles = await listTsFiles(sourceRoot);
  for (const sourcePath of sourceFiles) {
    const source = await readFile(sourcePath, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
      fileName: sourcePath,
    }).outputText;
    const destination = join(buildRoot, 'src', relative(sourceRoot, sourcePath).replace(/\.ts$/, '.js'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, output, 'utf8');
  }
  for (const workerName of ['continuous-assurance-evidence-adapter-worker.mjs', 'continuous-assurance-independent-verifier-worker.mjs']) {
    const sourcePath = join(projectRoot, 'worker-runtime', workerName);
    const source = (await readFile(sourcePath, 'utf8')).replace(/\.ts';/g, ".js';");
    const destination = join(buildRoot, 'worker-runtime', workerName);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source, 'utf8');
  }
}

async function listTsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listTsFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

function post(path: string, body: unknown, key?: string) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key) headers.set('x-unzen-idempotency-key', key);
  return { method: 'POST', headers, body: JSON.stringify(body) } as RequestInit;
}

describe('continuous assurance adapter Workers Miniflare multi-service smoke', () => {
  it('routes evidence capture through R2 and the independent verifier Service Binding', async () => {
    await withRuntime(async (mf) => {
      const archiveKey = 'cycle-miniflare-1:cycle-evidence-archive';
      const archived = await mf.dispatchFetch('http://evidence.mf/evidence/cycle/archive', post('/evidence/cycle/archive', {
        draft: cycleDraft(), minimumRetentionMs: 86_400_000, context: actionContext('cycle-evidence-archive', archiveKey),
      }, archiveKey));
      expect(archived.status).toBe(200);
      const retained = await archived.json() as any;
      expect(retained.evidenceContentDigest).toMatch(/^[a-f0-9]{64}$/);

      const payload = { ...cycleDraft(), retainedEvidence: retained, capturedAtMs: BASE + 21_000 };
      const captureKey = 'cycle-miniflare-1:cycle-evidence-capture';
      const captured = await mf.dispatchFetch('http://evidence.mf/evidence/cycle/capture', post('/evidence/cycle/capture', {
        payload, context: actionContext('cycle-evidence-capture', captureKey),
      }, captureKey));
      expect(captured.status).toBe(200);
      const envelope = await captured.json() as any;
      expect(envelope.evidenceLevel).toBe('captured-and-verified');
      expect(envelope.verification).toMatchObject({ verifier: VERIFIER_NAME, version: VERIFIER_VERSION, result: 'pass' });

      const loaded = await mf.dispatchFetch('http://evidence.mf/evidence/artifact/load', post('/evidence/artifact/load', { locator: envelope.artifact.locator }));
      expect(loaded.status).toBe(200);
      const artifactContent = await loaded.json();
      const verified = await mf.dispatchFetch('http://evidence.mf/evidence/artifact/verify', post('/evidence/artifact/verify', {
        envelope, actualSha256: envelope.artifact.sha256, artifactContent,
      }));
      expect(verified.status).toBe(200);
      expect(await verified.json()).toMatchObject({ verifier: VERIFIER_NAME, result: 'pass' });
    });
  });

  it('persists R2 artifacts across a Miniflare restart', async () => {
    await withRuntime(async (mf, persistRoot, buildRoot) => {
      const archiveKey = 'cycle-miniflare-1:cycle-evidence-archive';
      const archived = await mf.dispatchFetch('http://evidence.mf/evidence/cycle/archive', post('/evidence/cycle/archive', {
        draft: cycleDraft(), minimumRetentionMs: 86_400_000, context: actionContext('cycle-evidence-archive', archiveKey),
      }, archiveKey));
      const retained = await archived.json() as any;
      await mf.dispose();
      const restarted = createMiniflare(buildRoot, persistRoot);
      try {
        const locator = `r2://continuous-assurance-evidence/${encodeURIComponent(retained.evidenceArchiveId)}`;
        const loaded = await restarted.dispatchFetch('http://evidence.mf/evidence/artifact/load', post('/evidence/artifact/load', { locator }));
        expect(loaded.status).toBe(200);
        const body = await loaded.json() as any;
        expect(body.kind).toBe('bytes');
        expect(body.bytes.length).toBeGreaterThan(0);
      } finally {
        await restarted.dispose();
      }
    });
  });
});
