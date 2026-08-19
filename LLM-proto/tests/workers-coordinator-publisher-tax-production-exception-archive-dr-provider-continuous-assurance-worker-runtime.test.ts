import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTINUOUS_ASSURANCE_RUNTIME_CRON,
  CONTINUOUS_ASSURANCE_RUNTIME_SCOPE,
  createContinuousAssuranceWorkerRuntimeMiniflare,
  dispatchContinuousAssuranceScheduled,
  readContinuousAssuranceRuntimeLedger,
  type ContinuousAssuranceRuntimeEngineRequest,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-worker-runtime-smoke.js';

const SCHEDULED_AT = Date.parse('2026-08-20T00:30:00.000Z');

function engineResult(overrides: Record<string, unknown> = {}) {
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-automation',
    status: 'pass',
    cycleId: `steady-schedule-1-${SCHEDULED_AT}`,
    attempts: [
      { action: 'provider-audit', idempotencyKey: `steady-schedule-1-${SCHEDULED_AT}:provider-audit`, attempt: 1, status: 'success' },
      { action: 'primary-archive-retrieval', idempotencyKey: `steady-schedule-1-${SCHEDULED_AT}:primary-archive-retrieval`, attempt: 1, status: 'success' },
      { action: 'backup-archive-retrieval', idempotencyKey: `steady-schedule-1-${SCHEDULED_AT}:backup-archive-retrieval`, attempt: 1, status: 'success' },
    ],
    paging: { attempted: false, succeeded: true, dedupeKey: null },
    newCycleEvidence: { runId: `steady-schedule-1-${SCHEDULED_AT}` },
    newAggregateEvidence: { runId: 'steady-state-operations-2' },
    finalSteadyStateReport: { status: 'pass' },
    bottlenecksToIssue: [],
    ...overrides,
  };
}

async function withPersistRoot<T>(run: (persistRoot: string) => Promise<T>): Promise<T> {
  const persistRoot = await mkdtemp(join(tmpdir(), 'unzen-continuous-assurance-runtime-'));
  try {
    return await run(persistRoot);
  } finally {
    await rm(persistRoot, { recursive: true, force: true });
  }
}

describe('publisher tax exception archive DR provider continuous assurance Worker runtime', () => {
  it('dispatches a scheduled event through the Durable Object and persists the engine result', async () => {
    await withPersistRoot(async (persistRoot) => {
      const calls: ContinuousAssuranceRuntimeEngineRequest[] = [];
      const mf = createContinuousAssuranceWorkerRuntimeMiniflare({
        durableObjectsPersistRoot: persistRoot,
        engine: async (request) => {
          calls.push(request);
          return engineResult();
        },
      });
      try {
        await dispatchContinuousAssuranceScheduled(mf, SCHEDULED_AT);
        const ledger = await readContinuousAssuranceRuntimeLedger(mf, SCHEDULED_AT);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          scope: CONTINUOUS_ASSURANCE_RUNTIME_SCOPE,
          cron: CONTINUOUS_ASSURANCE_RUNTIME_CRON,
          scheduledTimeMs: SCHEDULED_AT,
          replayCount: 0,
        });
        expect(ledger).toMatchObject({
          state: 'completed',
          replayCount: 0,
          attemptCount: 1,
          firstFailure: null,
          latestCycleRunId: `steady-schedule-1-${SCHEDULED_AT}`,
          latestAggregateRunId: 'steady-state-operations-2',
        });
        expect(ledger?.actionKeys).toEqual([
          `steady-schedule-1-${SCHEDULED_AT}:provider-audit`,
          `steady-schedule-1-${SCHEDULED_AT}:primary-archive-retrieval`,
          `steady-schedule-1-${SCHEDULED_AT}:backup-archive-retrieval`,
        ]);
        expect((ledger?.result as { finalSteadyStateReport?: { status?: string } })?.finalSteadyStateReport?.status).toBe('pass');
      } finally {
        await mf.dispose();
      }
    });
  });

  it('does not re-run the engine for a duplicate completed delivery', async () => {
    await withPersistRoot(async (persistRoot) => {
      let calls = 0;
      const mf = createContinuousAssuranceWorkerRuntimeMiniflare({
        durableObjectsPersistRoot: persistRoot,
        engine: async () => {
          calls += 1;
          return engineResult();
        },
      });
      try {
        await dispatchContinuousAssuranceScheduled(mf, SCHEDULED_AT);
        await dispatchContinuousAssuranceScheduled(mf, SCHEDULED_AT);
        expect(calls).toBe(1);
        const ledger = await readContinuousAssuranceRuntimeLedger(mf, SCHEDULED_AT);
        expect(ledger?.attemptCount).toBe(1);
        expect(ledger?.state).toBe('completed');
      } finally {
        await mf.dispose();
      }
    });
  });

  it('persists completed state across a Miniflare restart', async () => {
    await withPersistRoot(async (persistRoot) => {
      let firstCalls = 0;
      let mf = createContinuousAssuranceWorkerRuntimeMiniflare({
        durableObjectsPersistRoot: persistRoot,
        engine: async () => {
          firstCalls += 1;
          return engineResult();
        },
      });
      await dispatchContinuousAssuranceScheduled(mf, SCHEDULED_AT);
      await mf.dispose();

      let replayEngineCalls = 0;
      mf = createContinuousAssuranceWorkerRuntimeMiniflare({
        durableObjectsPersistRoot: persistRoot,
        engine: async () => {
          replayEngineCalls += 1;
          return engineResult();
        },
      });
      try {
        const before = await readContinuousAssuranceRuntimeLedger(mf, SCHEDULED_AT);
        expect(before?.state).toBe('completed');
        await dispatchContinuousAssuranceScheduled(mf, SCHEDULED_AT);
        expect(firstCalls).toBe(1);
        expect(replayEngineCalls).toBe(0);
        expect((await readContinuousAssuranceRuntimeLedger(mf, SCHEDULED_AT))?.attemptCount).toBe(1);
      } finally {
        await mf.dispose();
      }
    });
  });

  it('recovers an interrupted running record after restart using the same trigger identity', async () => {
    await withPersistRoot(async (persistRoot) => {
      let mf = createContinuousAssuranceWorkerRuntimeMiniflare({
        durableObjectsPersistRoot: persistRoot,
        leaseMs: 1,
        engine: async () => {
          throw new Error('engine-crash');
        },
      });
      // scheduled() delegates the tick to waitUntil(), so delivery itself resolves
      // even when the background engine invocation fails. The durable ledger is the
      // authoritative failure/replay state.
      await dispatchContinuousAssuranceScheduled(mf, SCHEDULED_AT);
      const interrupted = await readContinuousAssuranceRuntimeLedger(mf, SCHEDULED_AT);
      expect(interrupted).toMatchObject({
        state: 'running',
        replayCount: 0,
        attemptCount: 1,
      });
      expect(interrupted?.firstFailure).toContain('worker-runtime-engine-failed:assurance-engine-http-503');
      await mf.dispose();

      await new Promise((resolve) => setTimeout(resolve, 5));
      const requests: ContinuousAssuranceRuntimeEngineRequest[] = [];
      mf = createContinuousAssuranceWorkerRuntimeMiniflare({
        durableObjectsPersistRoot: persistRoot,
        leaseMs: 1,
        engine: async (request) => {
          requests.push(request);
          return engineResult();
        },
      });
      try {
        await dispatchContinuousAssuranceScheduled(mf, SCHEDULED_AT);
        expect(requests).toHaveLength(1);
        expect(requests[0].replayCount).toBe(1);
        const recovered = await readContinuousAssuranceRuntimeLedger(mf, SCHEDULED_AT);
        expect(recovered).toMatchObject({
          state: 'completed',
          replayCount: 1,
          attemptCount: 2,
        });
        expect(recovered?.firstFailure).toContain('worker-runtime-engine-failed:assurance-engine-http-503');
      } finally {
        await mf.dispose();
      }
    });
  });

  it('serializes a concurrent duplicate while the first delivery owns the lease', async () => {
    await withPersistRoot(async (persistRoot) => {
      let releaseEngine!: () => void;
      let engineStarted!: () => void;
      const started = new Promise<void>((resolve) => { engineStarted = resolve; });
      const release = new Promise<void>((resolve) => { releaseEngine = resolve; });
      let calls = 0;
      const mf = createContinuousAssuranceWorkerRuntimeMiniflare({
        durableObjectsPersistRoot: persistRoot,
        leaseMs: 60_000,
        engine: async () => {
          calls += 1;
          engineStarted();
          await release;
          return engineResult();
        },
      });
      try {
        const first = dispatchContinuousAssuranceScheduled(mf, SCHEDULED_AT);
        await started;
        const second = dispatchContinuousAssuranceScheduled(mf, SCHEDULED_AT);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(calls).toBe(1);
        releaseEngine();
        await Promise.all([first, second]);
        expect(calls).toBe(1);
        expect((await readContinuousAssuranceRuntimeLedger(mf, SCHEDULED_AT))?.attemptCount).toBe(1);
      } finally {
        await mf.dispose();
      }
    });
  });

  it('persists the original operational failure separately from pager failure', async () => {
    await withPersistRoot(async (persistRoot) => {
      const mf = createContinuousAssuranceWorkerRuntimeMiniflare({
        durableObjectsPersistRoot: persistRoot,
        engine: async () => engineResult({
          status: 'hold',
          failureReason: 'continuous-assurance-action-failed:provider-audit:provider-down',
          paging: {
            attempted: true,
            succeeded: false,
            dedupeKey: `steady-schedule-1-${SCHEDULED_AT}:page`,
            error: 'pager-down',
          },
          finalSteadyStateReport: null,
        }),
      });
      try {
        await dispatchContinuousAssuranceScheduled(mf, SCHEDULED_AT);
        const ledger = await readContinuousAssuranceRuntimeLedger(mf, SCHEDULED_AT);
        expect(ledger?.firstFailure).toBe('continuous-assurance-action-failed:provider-audit:provider-down');
        expect(ledger?.paging).toMatchObject({ succeeded: false, error: 'pager-down' });
        expect((ledger?.result as { failureReason?: string })?.failureReason).toBe(
          'continuous-assurance-action-failed:provider-audit:provider-down',
        );
      } finally {
        await mf.dispose();
      }
    });
  });

  it('exposes only a health endpoint on the public Worker fetch surface', async () => {
    await withPersistRoot(async (persistRoot) => {
      const mf = createContinuousAssuranceWorkerRuntimeMiniflare({
        durableObjectsPersistRoot: persistRoot,
        engine: async () => engineResult(),
      });
      try {
        const health = await mf.dispatchFetch('https://worker.local/health');
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ ok: true });
        expect((await mf.dispatchFetch('https://worker.local/runtime-state')).status).toBe(404);
      } finally {
        await mf.dispose();
      }
    });
  });

  it('keeps Wrangler runtime configuration explicit and secret-free', async () => {
    const configPath = decodeURIComponent(
      new URL('../worker-runtime/wrangler.jsonc', import.meta.url).pathname,
    );
    const config = await readFile(configPath, 'utf8');
    expect(config).toContain('"compatibility_date": "2026-08-20"');
    expect(config).toContain('"nodejs_compat"');
    expect(config).toContain('"crons": ["*/5 * * * *"]');
    expect(config).toContain('"new_sqlite_classes": ["ContinuousAssuranceRuntimeState"]');
    expect(config).toContain('"CONTINUOUS_ASSURANCE_STATE"');
    expect(config).toContain('"ASSURANCE_ENGINE"');
    expect(config).toContain('"observability"');
    expect(config).not.toMatch(/api[_-]?key|token|password|secret/i);
  });
});
