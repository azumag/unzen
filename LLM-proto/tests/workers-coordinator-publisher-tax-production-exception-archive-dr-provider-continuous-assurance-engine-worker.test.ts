import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.js';

const SCOPE = 'publisher-tax-exception-archive-dr';
const CRON = '*/5 * * * *';
const SCHEDULED_AT = Date.parse('2026-08-20T00:30:00.000Z');
const DELIVERY_AT = SCHEDULED_AT + 1_000;
const NEXT_DUE = Date.parse('2026-08-20T00:40:00.000Z');
const ARTIFACT_CONTENT = 'hello';
const ARTIFACT_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const BOOTSTRAP_SECRET = 'test-bootstrap-secret';
const TRUSTED_VERIFIER = 'unzen-independent-evidence-verifier';

interface EngineStateStub {
  readState(scope?: string): Promise<{
    readonly currentRunId: string | null;
    readonly activeTriggerKey: string | null;
    readonly journals: readonly {
      readonly triggerKey: string;
      readonly state: string;
      readonly replayCount: number;
      readonly firstFailure: string | null;
      readonly result: { readonly status?: string } | null;
    }[];
  }>;
}

interface EngineStateNamespace {
  getByName(name: string): EngineStateStub;
}

function capturedAggregate() {
  const payload = {
    cycleRunIds: [] as string[],
    schedule: {
      scheduleId: 'steady-schedule-1',
      cadenceMs: 300_000,
      graceMs: 30_000,
      lastSuccessfulCycleAtMs: SCHEDULED_AT - 300_000,
      nextDueAtMs: NEXT_DUE,
    },
  };
  return {
    schemaVersion: '1.0.0',
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-approved',
    producer: {
      name: 'engine-worker-smoke',
      version: '1.0.0',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
    },
    runId: 'steady-state-operations-bootstrap-1',
    capturedAt: '2026-08-20T00:00:00.000Z',
    environment: {
      runtime: 'miniflare',
      runtimeVersion: '4',
      executionSurface: 'engine-worker-smoke',
      os: { name: 'linux', version: '24.04' },
    },
    scenario: {
      feature: 'continuous-assurance-engine-bootstrap',
      scenario: 'verified current snapshot',
      expectedResult: 'accepted',
    },
    artifact: {
      locator: 'artifact://steady-state-operations-bootstrap-1',
      sha256: ARTIFACT_SHA256,
      expiresAt: '2026-08-21T00:00:00.000Z',
    },
    verification: {
      verifier: TRUSTED_VERIFIER,
      version: '1.0.0',
      verifiedAt: '2026-08-20T00:00:02.000Z',
      result: 'pass',
    },
    redaction: { applied: true, policyVersion: 'engine-worker-smoke-v1' },
    payload,
  } as const;
}

function bootstrapSnapshot() {
  const steadyStateOperationsEvidence = capturedAggregate();
  return {
    steadyStateOperationsEvidence,
    steadyStateOperationsReport: {
      status: 'pass',
      steadyStateInputEvidence: steadyStateOperationsEvidence,
      cycleInputEvidence: [],
      steadyStateEvidenceSummary: {
        runId: steadyStateOperationsEvidence.runId,
        evidenceKind: steadyStateOperationsEvidence.evidenceKind,
        validationStatus: 'valid',
        effectiveEvidenceLevel: 'captured-and-verified',
        effectiveReadinessStatus: 'production-approved',
      },
    },
    updatedAtMs: Date.parse(steadyStateOperationsEvidence.capturedAt),
  };
}

async function withRuntime<T>(run: (mf: Miniflare, evidenceCalls: string[]) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'unzen-assurance-engine-'));
  const buildRoot = join(root, 'build');
  const persistRoot = join(root, 'persist');
  try {
    await compileEngineWorker(buildRoot);
    const evidenceCalls: string[] = [];
    const mf = createMiniflare(buildRoot, persistRoot, evidenceCalls);
    try {
      return await run(mf, evidenceCalls);
    } finally {
      await mf.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createMiniflare(buildRoot: string, persistRoot: string, evidenceCalls: string[]): Miniflare {
  return new Miniflare({
    modules: true,
    modulesRoot: buildRoot,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'], fallthrough: true }],
    scriptPath: join(buildRoot, 'worker-runtime', 'continuous-assurance-engine-worker.mjs'),
    compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      ENGINE_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET,
      TRUSTED_EVIDENCE_VERIFIERS_JSON: JSON.stringify([{ name: TRUSTED_VERIFIER }]),
    },
    durableObjects: {
      ENGINE_STATE: { className: 'ContinuousAssuranceEngineState', useSQLite: true },
    },
    durableObjectsPersist: persistRoot,
    serviceBindings: {
      PROVIDER_ADAPTER: async () => Response.json({ error: 'provider-adapter-not-expected-for-idle-smoke' }, { status: 503 }),
      PAGER_ADAPTER: async () => Response.json({ ok: true }),
      EVIDENCE_ADAPTER: async (request: Request) => {
        const path = new URL(request.url).pathname;
        evidenceCalls.push(path);
        if (path === '/evidence/artifact/load') {
          return Response.json({ kind: 'utf8', content: ARTIFACT_CONTENT });
        }
        if (path === '/evidence/artifact/verify') {
          return Response.json({
            verifier: TRUSTED_VERIFIER,
            version: '1.0.0',
            verifiedAt: '2026-08-20T00:00:02.000Z',
            result: 'pass',
          });
        }
        return Response.json({ error: 'unexpected-evidence-adapter-path' }, { status: 404 });
      },
    },
  });
}

async function compileEngineWorker(buildRoot: string): Promise<void> {
  const projectRoot = decodeURIComponent(new URL('..', import.meta.url).pathname);
  const sourceRoot = join(projectRoot, 'src');
  const sourceFiles = await listTsFiles(sourceRoot);
  for (const sourcePath of sourceFiles) {
    const source = await readFile(sourcePath, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      fileName: sourcePath,
    }).outputText;
    const destination = join(buildRoot, 'src', relative(sourceRoot, sourcePath).replace(/\.ts$/, '.js'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, output, 'utf8');
  }

  const workerSourcePath = join(projectRoot, 'worker-runtime', 'continuous-assurance-engine-worker.mjs');
  const workerSource = (await readFile(workerSourcePath, 'utf8')).replace(
    '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.ts',
    '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.js',
  );
  const workerDestination = join(buildRoot, 'worker-runtime', 'continuous-assurance-engine-worker.mjs');
  await mkdir(dirname(workerDestination), { recursive: true });
  await writeFile(workerDestination, workerSource, 'utf8');
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

async function bootstrap(mf: Miniflare, snapshot = bootstrapSnapshot(), secret = BOOTSTRAP_SECRET) {
  return mf.dispatchFetch('https://engine.internal/bootstrap', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unzen-bootstrap-secret': secret,
    },
    body: JSON.stringify({ scope: SCOPE, snapshot, nowMs: DELIVERY_AT }),
  });
}

async function tick(mf: Miniflare, replayCount = 0) {
  return mf.dispatchFetch('https://engine.internal/tick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: SCOPE,
      triggerKey: `${SCOPE}:${CRON}:${SCHEDULED_AT}`,
      cron: CRON,
      scheduledTimeMs: SCHEDULED_AT,
      deliveryAtMs: DELIVERY_AT,
      replayCount,
    }),
  });
}

async function readState(mf: Miniflare) {
  const namespace = await mf.getDurableObjectNamespace('ENGINE_STATE') as unknown as EngineStateNamespace;
  return namespace.getByName(SCOPE).readState(SCOPE);
}

describe('continuous assurance engine Worker Miniflare smoke', () => {
  it('protects bootstrap with a secret and independently verifies the initial captured snapshot', async () => {
    await withRuntime(async (mf, evidenceCalls) => {
      expect((await bootstrap(mf, bootstrapSnapshot(), 'wrong-secret')).status).toBe(403);
      const response = await bootstrap(mf);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'seeded', runId: 'steady-state-operations-bootstrap-1' });
      expect(evidenceCalls).toEqual(['/evidence/artifact/load', '/evidence/artifact/verify']);
      expect((await readState(mf)).currentRunId).toBe('steady-state-operations-bootstrap-1');
    });
  });

  it('runs the real #137 automation through /tick and persists an idle journal without provider side effects', async () => {
    await withRuntime(async (mf) => {
      expect((await bootstrap(mf)).status).toBe(200);
      const response = await tick(mf);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'idle' });
      const state = await readState(mf);
      expect(state.currentRunId).toBe('steady-state-operations-bootstrap-1');
      expect(state.activeTriggerKey).toBeNull();
      expect(state.journals).toHaveLength(1);
      expect(state.journals[0]).toMatchObject({ state: 'completed', replayCount: 0, firstFailure: null });
      expect(state.journals[0].result).toMatchObject({ status: 'idle' });
    });
  });

  it('returns a completed duplicate from the engine journal instead of revalidating or re-running adapters', async () => {
    await withRuntime(async (mf, evidenceCalls) => {
      expect((await bootstrap(mf)).status).toBe(200);
      expect((await tick(mf)).status).toBe(200);
      const callsAfterFirstTick = evidenceCalls.length;
      const duplicate = await tick(mf);
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ status: 'idle' });
      expect(evidenceCalls).toHaveLength(callsAfterFirstTick);
      expect((await readState(mf)).journals).toHaveLength(1);
    });
  });

  it('rejects self-reported bootstrap evidence and keeps the engine uninitialized', async () => {
    await withRuntime(async (mf) => {
      const candidate = bootstrapSnapshot();
      const selfReported = {
        ...candidate.steadyStateOperationsEvidence,
        evidenceLevel: 'self-reported-runtime',
        readinessStatus: 'runtime-observed',
        producer: { name: 'engine-worker-smoke', version: '1.0.0' },
        environment: { runtime: 'miniflare', runtimeVersion: '4', executionSurface: 'engine-worker-smoke' },
      };
      delete (selfReported as Record<string, unknown>).artifact;
      delete (selfReported as Record<string, unknown>).verification;
      delete (selfReported as Record<string, unknown>).scenario;
      const report = {
        ...candidate.steadyStateOperationsReport,
        steadyStateInputEvidence: selfReported,
        steadyStateEvidenceSummary: { ...candidate.steadyStateOperationsReport.steadyStateEvidenceSummary },
      };
      const response = await bootstrap(mf, {
        ...candidate,
        steadyStateOperationsEvidence: selfReported as never,
        steadyStateOperationsReport: report as never,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ status: 'rejected', failureReason: 'bootstrap-evidence-not-production-approved' });
      expect((await readState(mf)).currentRunId).toBeNull();
    });
  });

  it('keeps production engine configuration internal-only, binding-aligned, and secret-free', async () => {
    const projectRoot = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const engineConfig = await readFile(join(projectRoot, 'worker-runtime', 'wrangler.engine.jsonc'), 'utf8');
    const runtimeConfig = await readFile(join(projectRoot, 'worker-runtime', 'wrangler.jsonc'), 'utf8');
    expect(engineConfig).toContain('"name": "unzen-llm-continuous-assurance-engine"');
    expect(engineConfig).toContain('"compatibility_date": "2026-08-20"');
    expect(engineConfig).toContain('"workers_dev": false');
    expect(engineConfig).toContain('"new_sqlite_classes": ["ContinuousAssuranceEngineState"]');
    expect(engineConfig).toContain('"PROVIDER_ADAPTER"');
    expect(engineConfig).toContain('"EVIDENCE_ADAPTER"');
    expect(engineConfig).toContain('"PAGER_ADAPTER"');
    expect(engineConfig).not.toContain('ENGINE_BOOTSTRAP_SECRET');
    expect(engineConfig).not.toMatch(/api[_-]?key|password|bearer/i);
    expect(runtimeConfig).toContain('"service": "unzen-llm-continuous-assurance-engine"');
    expect(engineConfig).not.toContain('"routes"');
  });
});
