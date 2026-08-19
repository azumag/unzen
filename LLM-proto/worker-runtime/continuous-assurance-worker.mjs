import { DurableObject } from 'cloudflare:workers';

const DEFAULT_SCOPE = 'publisher-tax-exception-archive-dr';
const DEFAULT_LEASE_MS = 60_000;

function numberBinding(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function scheduledTimeMs(controller) {
  const value = controller.scheduledTime;
  return value instanceof Date ? value.getTime() : Number(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class ContinuousAssuranceRuntimeState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS execution_ledger (
        trigger_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        cron TEXT NOT NULL,
        scheduled_at_ms INTEGER NOT NULL,
        state TEXT NOT NULL,
        replay_count INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL,
        cycle_id TEXT,
        action_keys_json TEXT NOT NULL,
        first_failure TEXT,
        paging_json TEXT,
        latest_cycle_run_id TEXT,
        latest_aggregate_run_id TEXT,
        result_json TEXT,
        started_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  async runScheduled(input) {
    const scope = this.env.CONTINUOUS_ASSURANCE_SCOPE || DEFAULT_SCOPE;
    const leaseMs = numberBinding(this.env.RUN_LEASE_MS, DEFAULT_LEASE_MS);
    const triggerKey = `${scope}:${input.cron}:${input.scheduledTimeMs}`;
    const existing = this.#read(triggerKey);

    if (existing?.state === 'completed' && existing.result_json) {
      return {
        ...JSON.parse(existing.result_json),
        runtimeDelivery: {
          triggerKey,
          replayCount: existing.replay_count,
          replayed: true,
          durableState: 'completed',
        },
      };
    }

    if (existing?.state === 'running' && existing.lease_until_ms > input.deliveryAtMs) {
      return {
        runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-worker-runtime',
        status: 'in-progress',
        triggerKey,
        cycleId: existing.cycle_id,
        replayCount: existing.replay_count,
      };
    }

    const replayCount = existing ? existing.replay_count + 1 : 0;
    const attemptCount = (existing?.attempt_count ?? 0) + 1;
    const startedAtMs = existing?.started_at_ms ?? input.deliveryAtMs;
    const leaseUntilMs = input.deliveryAtMs + leaseMs;

    this.ctx.storage.sql.exec(
      `INSERT INTO execution_ledger (
        trigger_key, scope, cron, scheduled_at_ms, state, replay_count, attempt_count,
        lease_until_ms, cycle_id, action_keys_json, first_failure, paging_json,
        latest_cycle_run_id, latest_aggregate_run_id, result_json,
        started_at_ms, completed_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, '[]', ?, NULL, NULL, NULL, NULL, ?, NULL, ?)
      ON CONFLICT(trigger_key) DO UPDATE SET
        state = 'running', replay_count = excluded.replay_count,
        attempt_count = excluded.attempt_count, lease_until_ms = excluded.lease_until_ms,
        updated_at_ms = excluded.updated_at_ms`,
      triggerKey,
      scope,
      input.cron,
      input.scheduledTimeMs,
      replayCount,
      attemptCount,
      leaseUntilMs,
      existing?.cycle_id ?? null,
      existing?.first_failure ?? null,
      startedAtMs,
      input.deliveryAtMs,
    );

    try {
      const response = await this.env.ASSURANCE_ENGINE.fetch(new Request('https://assurance-engine.internal/tick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope,
          triggerKey,
          cron: input.cron,
          scheduledTimeMs: input.scheduledTimeMs,
          deliveryAtMs: input.deliveryAtMs,
          replayCount,
        }),
      }));
      if (!response.ok) {
        throw new Error(`assurance-engine-http-${response.status}`);
      }

      const result = await response.json();
      const actionKeys = Array.isArray(result.attempts)
        ? [...new Set(result.attempts.map((attempt) => attempt?.idempotencyKey).filter(Boolean))]
        : [];
      const firstFailure = existing?.first_failure ?? result.failureReason ?? null;
      const paging = result.paging ?? null;
      const cycleId = result.cycleId ?? existing?.cycle_id ?? null;
      const latestCycleRunId = result.newCycleEvidence?.runId ?? null;
      const latestAggregateRunId = result.newAggregateEvidence?.runId ?? null;

      this.ctx.storage.sql.exec(
        `UPDATE execution_ledger SET
          state = 'completed', cycle_id = ?, action_keys_json = ?, first_failure = ?,
          paging_json = ?, latest_cycle_run_id = ?, latest_aggregate_run_id = ?,
          result_json = ?, completed_at_ms = ?, updated_at_ms = ?
        WHERE trigger_key = ?`,
        cycleId,
        JSON.stringify(actionKeys),
        firstFailure,
        paging ? JSON.stringify(paging) : null,
        latestCycleRunId,
        latestAggregateRunId,
        JSON.stringify(result),
        input.deliveryAtMs,
        input.deliveryAtMs,
        triggerKey,
      );

      console.log(JSON.stringify({
        event: 'continuous_assurance_tick_completed',
        triggerKey,
        status: result.status,
        replayCount,
        failureReason: firstFailure,
      }));

      return {
        ...result,
        runtimeDelivery: {
          triggerKey,
          replayCount,
          replayed: replayCount > 0,
          durableState: 'completed',
        },
      };
    } catch (error) {
      const runtimeFailure = `worker-runtime-engine-failed:${errorMessage(error)}`;
      const firstFailure = existing?.first_failure ?? runtimeFailure;
      this.ctx.storage.sql.exec(
        `UPDATE execution_ledger SET
          first_failure = ?, updated_at_ms = ?
        WHERE trigger_key = ?`,
        firstFailure,
        input.deliveryAtMs,
        triggerKey,
      );
      console.error(JSON.stringify({
        event: 'continuous_assurance_tick_interrupted',
        triggerKey,
        replayCount,
        failureReason: firstFailure,
      }));
      throw error;
    }
  }

  async readLedger(triggerKey) {
    const row = this.#read(triggerKey);
    if (!row) return null;
    return {
      triggerKey: row.trigger_key,
      scope: row.scope,
      cron: row.cron,
      scheduledAtMs: row.scheduled_at_ms,
      state: row.state,
      replayCount: row.replay_count,
      attemptCount: row.attempt_count,
      leaseUntilMs: row.lease_until_ms,
      cycleId: row.cycle_id,
      actionKeys: JSON.parse(row.action_keys_json || '[]'),
      firstFailure: row.first_failure,
      paging: row.paging_json ? JSON.parse(row.paging_json) : null,
      latestCycleRunId: row.latest_cycle_run_id,
      latestAggregateRunId: row.latest_aggregate_run_id,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      startedAtMs: row.started_at_ms,
      completedAtMs: row.completed_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  #read(triggerKey) {
    return this.ctx.storage.sql.exec(
      'SELECT * FROM execution_ledger WHERE trigger_key = ?',
      triggerKey,
    ).toArray()[0] ?? null;
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-worker-runtime',
      });
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    const scope = env.CONTINUOUS_ASSURANCE_SCOPE || DEFAULT_SCOPE;
    const stub = env.CONTINUOUS_ASSURANCE_STATE.getByName(scope);
    const input = {
      scheduledTimeMs: scheduledTimeMs(controller),
      cron: controller.cron,
      deliveryAtMs: Date.now(),
    };
    ctx.waitUntil(stub.runScheduled(input));
  },
};
