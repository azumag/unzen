import { describe, expect, it } from 'vitest';
import { runProductionDeploymentCanary } from '../worker-runtime/continuous-assurance-production-canary-worker.mjs';

const NOW = Date.now();
const CONFIG_SHA = 'a'.repeat(64);
const SECRET = 'test-canary-dispatch-secret';
const VERIFIER = 'unzen-independent-evidence-verifier';

function metadata(service: string, suffix: string) {
  return {
    service,
    versionId: `version-${suffix}-12345678`,
    versionTag: `tag-${suffix}`,
    versionTimestamp: new Date(NOW - 60_000).toISOString(),
    configFingerprintSha256: CONFIG_SHA,
  };
}

function binding(handler: (request: Request) => Promise<Response> | Response) {
  return { fetch: handler };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const provider = metadata('unzen-llm-continuous-assurance-provider-adapter', 'provider');
  const evidence = metadata('unzen-llm-continuous-assurance-evidence-adapter', 'evidence');
  const pager = metadata('unzen-llm-continuous-assurance-pager-adapter', 'pager');
  const engine = metadata('unzen-llm-continuous-assurance-engine', 'engine');
  const runtime = metadata('unzen-llm-continuous-assurance', 'runtime');
  const verifier = metadata('unzen-llm-continuous-assurance-independent-verifier', 'verifier');
  const writes: { key: string; value: unknown; options: unknown }[] = [];
  let runtimeCalls = 0;

  const env = {
    CF_VERSION_METADATA: {
      id: 'version-controller-12345678',
      tag: 'tag-controller',
      timestamp: new Date(NOW - 60_000).toISOString(),
    },
    CONFIG_FINGERPRINT_SHA256: CONFIG_SHA,
    CONTINUOUS_ASSURANCE_SCOPE: 'publisher-tax-exception-archive-dr',
    CANARY_DISPATCH_SECRET: SECRET,
    TRUSTED_VERIFIER_NAME: VERIFIER,
    CANARY_RETENTION_MS: '2592000000',
    DEPLOY_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567',
    PROVIDER_ADAPTER: binding(() => Response.json(provider)),
    EVIDENCE_ADAPTER: binding(() => Response.json(evidence)),
    PAGER_ADAPTER: binding(() => Response.json(pager)),
    ASSURANCE_ENGINE: binding(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/__meta') return Response.json(engine);
      if (url.pathname === '/__canary/state') {
        return Response.json({
          scope: 'publisher-tax-exception-archive-dr',
          currentRunId: 'steady-state-current',
          snapshotUpdatedAtMs: NOW - 5_000,
          nextDueAtMs: NOW + 300_000,
        });
      }
      if (url.pathname === '/__canary/bindings') return Response.json({ provider, evidence, pager });
      return new Response('not found', { status: 404 });
    }),
    CONTINUOUS_ASSURANCE_RUNTIME: binding(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/__meta') return Response.json(runtime);
      if (url.pathname !== '/__canary/dispatch') return new Response('not found', { status: 404 });
      if (request.headers.get('x-unzen-canary-secret') !== SECRET) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      runtimeCalls += 1;
      const body = await request.json() as { cron: string; scheduledTimeMs: number };
      return Response.json({
        status: 'idle',
        cycleId: 'schedule-1:next-cycle',
        attempts: [],
        newCycleEvidence: null,
        newAggregateEvidence: null,
        failureReason: null,
        runtimeDelivery: {
          durableState: 'completed',
          replayCount: runtimeCalls === 1 ? 0 : 0,
          replayed: runtimeCalls > 1,
          triggerKey: `publisher-tax-exception-archive-dr:${body.cron}:${body.scheduledTimeMs}`,
        },
      });
    }),
    INDEPENDENT_VERIFIER: binding(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/__meta') return Response.json(verifier);
      const body = await request.json() as any;
      if (url.pathname === '/verify/capture') {
        return Response.json({
          verifier: VERIFIER,
          version: '1.0.0',
          verifiedAt: new Date(body.payload.capturedAtMs + 1_000).toISOString(),
          result: 'pass',
          evidenceKind: body.evidenceKind,
          runId: body.runId,
          readinessStatus: 'production-candidate',
        });
      }
      if (url.pathname === '/verify/artifact') {
        return Response.json({
          verifier: VERIFIER,
          version: '1.0.0',
          verifiedAt: new Date(0).toISOString(),
          result: 'fail',
          reason: 'artifact-digest-mismatch',
        }, { status: 409 });
      }
      return new Response('not found', { status: 404 });
    }),
    CANARY_EVIDENCE_BUCKET: {
      async put(key: string, value: unknown, options: unknown) {
        writes.push({ key, value, options });
      },
    },
    ...overrides,
  };
  return { env, writes, getRuntimeCalls: () => runtimeCalls, metas: { provider, evidence, pager, engine, runtime, verifier } };
}

describe('continuous assurance production deployment canary controller', () => {
  it('runs a read-only deployed wiring canary and captures a verified R2 artifact', async () => {
    const { env, writes, getRuntimeCalls } = makeEnv();
    const envelope = await runProductionDeploymentCanary({ scheduledTimeMs: NOW }, env as any);
    expect(envelope.evidenceLevel).toBe('captured-and-verified');
    expect(envelope.readinessStatus).toBe('production-candidate');
    expect(envelope.payload.runtimeResult.status).toBe('idle');
    expect(envelope.payload.runtimeResult.actionIdempotencyKeys).toEqual([]);
    expect(envelope.payload.runtimeResult.latestCycleRunId).toBeNull();
    expect(envelope.payload.runtimeResult.latestAggregateRunId).toBeNull();
    expect(envelope.payload.deployments).toHaveLength(7);
    expect(envelope.payload.negativeChecks).toEqual({
      badDispatchSecretRejected: true,
      duplicateCompletedDispatchSuppressed: true,
      versionOrConfigMismatchRejected: true,
      digestMismatchRejected: true,
      untrustedVerifierRejected: true,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toContain('deployment-canary/');
    expect(getRuntimeCalls()).toBe(2);
  });

  it('fails closed when engine-observed adapter versions differ from direct bindings', async () => {
    const base = makeEnv();
    const badEngine = binding(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/__meta') return Response.json(base.metas.engine);
      if (url.pathname === '/__canary/state') {
        return Response.json({ currentRunId: 'steady', snapshotUpdatedAtMs: NOW - 5_000, nextDueAtMs: NOW + 300_000 });
      }
      if (url.pathname === '/__canary/bindings') {
        return Response.json({
          provider: { ...base.metas.provider, versionId: 'version-provider-different' },
          evidence: base.metas.evidence,
          pager: base.metas.pager,
        });
      }
      return new Response('not found', { status: 404 });
    });
    const { env } = makeEnv({ ASSURANCE_ENGINE: badEngine });
    await expect(runProductionDeploymentCanary({ scheduledTimeMs: NOW }, env as any))
      .rejects.toThrow('production-canary-engine-binding-version-mismatch');
  });

  it('fails closed if the runtime does not reject the deliberately bad dispatch secret', async () => {
    const permissiveRuntime = binding(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/__meta') return Response.json(metadata('unzen-llm-continuous-assurance', 'runtime'));
      if (url.pathname === '/__canary/dispatch') {
        return Response.json({ status: 'idle', cycleId: 'cycle', attempts: [], runtimeDelivery: { durableState: 'completed', replayCount: 0, replayed: false } });
      }
      return new Response('not found', { status: 404 });
    });
    const { env } = makeEnv({ CONTINUOUS_ASSURANCE_RUNTIME: permissiveRuntime });
    await expect(runProductionDeploymentCanary({ scheduledTimeMs: NOW }, env as any))
      .rejects.toThrow('production-canary-bad-secret-not-rejected');
  });
});
