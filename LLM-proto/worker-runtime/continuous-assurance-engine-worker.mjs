import { DurableObject } from 'cloudflare:workers';
import {
  createContinuousAssuranceEvidenceValidationOptions,
  createContinuousAssuranceServiceBindingExecutor,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService,
  validateContinuousAssuranceEngineBootstrapSnapshot,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.ts';

const DEFAULT_SCOPE = 'publisher-tax-exception-archive-dr';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function engineErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'engine-service-failed';
}

function engineStatusForCode(code) {
  return code === 'engine-trigger-identity-invalid' || code === 'engine-trigger-timeline-invalid'
    ? 400
    : code === 'engine-trigger-in-progress' || code === 'engine-scope-busy'
      ? 409
      : 503;
}

function parseTrustedVerifiers(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.name === 'string')
      : [];
  } catch {
    return [];
  }
}

async function timingSafeSecretEquals(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function engineRuntimeError(error) {
  const code = engineErrorCode(error);
  return Response.json(
    { error: code, message: errorMessage(error) },
    { status: engineStatusForCode(code) },
  );
}

export class ContinuousAssuranceEngineState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS current_snapshot (
        scope TEXT PRIMARY KEY,
        current_run_id TEXT NOT NULL,
        report_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS engine_scope (
        scope TEXT PRIMARY KEY,
        active_trigger_key TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS execution_journal (
        trigger_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        replay_count INTEGER NOT NULL,
        base_aggregate_run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        first_failure TEXT,
        result_json TEXT,
        committed_aggregate_run_id TEXT,
        started_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  async bootstrap(input) {
    const scope = input.scope || DEFAULT_SCOPE;
    const active = this.#activeTrigger(scope);
    if (active) return { status: 'rejected', failureReason: 'engine-bootstrap-scope-active' };

    const current = this.#snapshotRow(scope);
    const expectedCurrentRunId = input.expectedCurrentRunId ?? null;
    if (current) {
      if (!expectedCurrentRunId) return { status: 'rejected', failureReason: 'engine-bootstrap-current-exists' };
      if (current.current_run_id !== expectedCurrentRunId) {
        return { status: 'rejected', failureReason: 'engine-bootstrap-current-run-mismatch' };
      }
    } else if (expectedCurrentRunId) {
      return { status: 'rejected', failureReason: 'engine-bootstrap-current-missing' };
    }

    const snapshot = input.snapshot;
    const validationOptions = this.#evidenceValidationOptions(input.nowMs ?? Date.now());
    const validation = await validateContinuousAssuranceEngineBootstrapSnapshot(snapshot, validationOptions);
    if (!validation.valid) return { status: 'rejected', failureReason: validation.failureReason };

    const runId = snapshot.steadyStateOperationsEvidence.runId;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO current_snapshot (scope, current_run_id, report_json, evidence_json, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           current_run_id = excluded.current_run_id,
           report_json = excluded.report_json,
           evidence_json = excluded.evidence_json,
           updated_at_ms = excluded.updated_at_ms`,
        scope,
        runId,
        JSON.stringify(snapshot.steadyStateOperationsReport),
        JSON.stringify(snapshot.steadyStateOperationsEvidence),
        snapshot.updatedAtMs,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO engine_scope (scope, active_trigger_key) VALUES (?, NULL)
         ON CONFLICT(scope) DO NOTHING`,
        scope,
      );
    });
    return { status: 'seeded', scope, runId };
  }

  async runTick(request) {
    const executor = createContinuousAssuranceServiceBindingExecutor({
      provider: this.env.PROVIDER_ADAPTER,
      evidence: this.env.EVIDENCE_ADAPTER,
      pager: this.env.PAGER_ADAPTER,
    });
    try {
      return {
        ok: true,
        result: await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService({
          request,
          repository: this.#repository(),
          executor,
          evidenceValidationOptions: this.#evidenceValidationOptions(request.deliveryAtMs),
        }),
      };
    } catch (error) {
      return {
        ok: false,
        error: engineErrorCode(error),
        message: errorMessage(error),
      };
    }
  }

  async readState(scope = DEFAULT_SCOPE) {
    const snapshot = this.#snapshotRow(scope);
    const activeTriggerKey = this.#activeTrigger(scope);
    const journals = this.ctx.storage.sql.exec(
      `SELECT trigger_key, scope, replay_count, base_aggregate_run_id, state,
              first_failure, result_json, committed_aggregate_run_id,
              started_at_ms, updated_at_ms
       FROM execution_journal WHERE scope = ? ORDER BY started_at_ms, trigger_key`,
      scope,
    ).toArray().map((row) => ({
      triggerKey: row.trigger_key,
      scope: row.scope,
      replayCount: row.replay_count,
      baseAggregateRunId: row.base_aggregate_run_id,
      state: row.state,
      firstFailure: row.first_failure,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      committedAggregateRunId: row.committed_aggregate_run_id,
      startedAtMs: row.started_at_ms,
      updatedAtMs: row.updated_at_ms,
    }));
    return {
      scope,
      activeTriggerKey,
      currentRunId: snapshot?.current_run_id ?? null,
      snapshot: snapshot ? {
        steadyStateOperationsReport: JSON.parse(snapshot.report_json),
        steadyStateOperationsEvidence: JSON.parse(snapshot.evidence_json),
        updatedAtMs: snapshot.updated_at_ms,
      } : null,
      journals,
    };
  }

  #repository() {
    return {
      loadSnapshot: async (scope) => {
        const row = this.#snapshotRow(scope);
        if (!row) return null;
        return {
          steadyStateOperationsReport: JSON.parse(row.report_json),
          steadyStateOperationsEvidence: JSON.parse(row.evidence_json),
          updatedAtMs: row.updated_at_ms,
        };
      },
      claimExecution: async ({ request, baseAggregateRunId }) => {
        const existing = this.#journalRow(request.triggerKey);
        if (existing?.state === 'completed' && existing.result_json) {
          return { kind: 'completed', result: JSON.parse(existing.result_json) };
        }
        if (existing) {
          if (request.replayCount <= existing.replay_count || existing.state !== 'interrupted') {
            return { kind: 'in-progress', activeTriggerKey: request.triggerKey };
          }
          const active = this.#activeTrigger(request.scope);
          if (active && active !== request.triggerKey) {
            return { kind: 'scope-busy', activeTriggerKey: active };
          }
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
              `UPDATE execution_journal
               SET state = 'running', replay_count = ?, updated_at_ms = ?
               WHERE trigger_key = ?`,
              request.replayCount,
              request.deliveryAtMs,
              request.triggerKey,
            );
            this.#setActiveTrigger(request.scope, request.triggerKey);
          });
          return {
            kind: 'claimed',
            journal: this.#journal(request.triggerKey),
          };
        }

        const active = this.#activeTrigger(request.scope);
        if (active && active !== request.triggerKey) {
          return { kind: 'scope-busy', activeTriggerKey: active };
        }
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            `INSERT INTO execution_journal (
              trigger_key, scope, replay_count, base_aggregate_run_id, state,
              first_failure, result_json, committed_aggregate_run_id,
              started_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, ?)`,
            request.triggerKey,
            request.scope,
            request.replayCount,
            baseAggregateRunId,
            request.deliveryAtMs,
            request.deliveryAtMs,
          );
          this.#setActiveTrigger(request.scope, request.triggerKey);
        });
        return { kind: 'claimed', journal: this.#journal(request.triggerKey) };
      },
      completePassExecution: async ({
        triggerKey,
        scope,
        expectedAggregateRunId,
        snapshot,
        result,
        completedAtMs,
      }) => this.ctx.storage.transactionSync(() => {
        const current = this.#snapshotRow(scope);
        if (!current || current.current_run_id !== expectedAggregateRunId) return false;
        const journal = this.#journalRow(triggerKey);
        if (!journal || journal.state !== 'running') return false;
        const committedRunId = snapshot.steadyStateOperationsEvidence.runId;
        this.ctx.storage.sql.exec(
          `UPDATE current_snapshot SET current_run_id = ?, report_json = ?, evidence_json = ?, updated_at_ms = ?
           WHERE scope = ? AND current_run_id = ?`,
          committedRunId,
          JSON.stringify(snapshot.steadyStateOperationsReport),
          JSON.stringify(snapshot.steadyStateOperationsEvidence),
          snapshot.updatedAtMs,
          scope,
          expectedAggregateRunId,
        );
        this.ctx.storage.sql.exec(
          `UPDATE execution_journal SET state = 'completed', result_json = ?,
             committed_aggregate_run_id = ?, updated_at_ms = ? WHERE trigger_key = ?`,
          JSON.stringify(result),
          committedRunId,
          completedAtMs,
          triggerKey,
        );
        this.#clearActiveTrigger(scope, triggerKey);
        return true;
      }),
      completeExecution: async ({ triggerKey, result, committedAggregateRunId, completedAtMs }) => {
        const journal = this.#journalRow(triggerKey);
        if (!journal) throw new Error('engine-journal-missing');
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            `UPDATE execution_journal SET state = 'completed', result_json = ?,
               committed_aggregate_run_id = ?, updated_at_ms = ? WHERE trigger_key = ?`,
            JSON.stringify(result),
            committedAggregateRunId,
            completedAtMs,
            triggerKey,
          );
          this.#clearActiveTrigger(journal.scope, triggerKey);
        });
      },
      interruptExecution: async ({ triggerKey, failure, updatedAtMs }) => {
        this.ctx.storage.sql.exec(
          `UPDATE execution_journal SET state = 'interrupted',
             first_failure = COALESCE(first_failure, ?), updated_at_ms = ?
           WHERE trigger_key = ?`,
          failure,
          updatedAtMs,
          triggerKey,
        );
      },
    };
  }

  #evidenceValidationOptions(now) {
    return createContinuousAssuranceEvidenceValidationOptions({
      binding: this.env.EVIDENCE_ADAPTER,
      trustedVerifiers: parseTrustedVerifiers(this.env.TRUSTED_EVIDENCE_VERIFIERS_JSON),
      now,
    });
  }

  #snapshotRow(scope) {
    return this.ctx.storage.sql.exec(
      'SELECT * FROM current_snapshot WHERE scope = ?',
      scope,
    ).toArray()[0] ?? null;
  }

  #journalRow(triggerKey) {
    return this.ctx.storage.sql.exec(
      'SELECT * FROM execution_journal WHERE trigger_key = ?',
      triggerKey,
    ).toArray()[0] ?? null;
  }

  #journal(triggerKey) {
    const row = this.#journalRow(triggerKey);
    if (!row) throw new Error('engine-journal-missing');
    return {
      triggerKey: row.trigger_key,
      scope: row.scope,
      replayCount: row.replay_count,
      baseAggregateRunId: row.base_aggregate_run_id,
      state: row.state,
      firstFailure: row.first_failure,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      committedAggregateRunId: row.committed_aggregate_run_id,
      startedAtMs: row.started_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  #activeTrigger(scope) {
    return this.ctx.storage.sql.exec(
      'SELECT active_trigger_key FROM engine_scope WHERE scope = ?',
      scope,
    ).toArray()[0]?.active_trigger_key ?? null;
  }

  #setActiveTrigger(scope, triggerKey) {
    this.ctx.storage.sql.exec(
      `INSERT INTO engine_scope (scope, active_trigger_key) VALUES (?, ?)
       ON CONFLICT(scope) DO UPDATE SET active_trigger_key = excluded.active_trigger_key`,
      scope,
      triggerKey,
    );
  }

  #clearActiveTrigger(scope, triggerKey) {
    this.ctx.storage.sql.exec(
      'UPDATE engine_scope SET active_trigger_key = NULL WHERE scope = ? AND active_trigger_key = ?',
      scope,
      triggerKey,
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        ok: true,
        runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-engine-service',
      });
    }
    if (request.method === 'POST' && url.pathname === '/bootstrap') {
      const authorized = await timingSafeSecretEquals(
        request.headers.get('x-unzen-bootstrap-secret'),
        env.ENGINE_BOOTSTRAP_SECRET,
      );
      if (!authorized) return Response.json({ error: 'forbidden' }, { status: 403 });
      const input = await request.json();
      const scope = input.scope || DEFAULT_SCOPE;
      try {
        const result = await env.ENGINE_STATE.getByName(scope).bootstrap(input);
        return Response.json(result, { status: result.status === 'seeded' ? 200 : 409 });
      } catch (error) {
        return engineRuntimeError(error);
      }
    }
    if (request.method === 'POST' && url.pathname === '/tick') {
      const input = await request.json();
      const scope = input.scope || DEFAULT_SCOPE;
      try {
        const outcome = await env.ENGINE_STATE.getByName(scope).runTick(input);
        if (!outcome.ok) {
          return Response.json(
            { error: outcome.error, message: outcome.message },
            { status: engineStatusForCode(outcome.error) },
          );
        }
        return Response.json(outcome.result);
      } catch (error) {
        return engineRuntimeError(error);
      }
    }
    return new Response('not found', { status: 404 });
  },
};
