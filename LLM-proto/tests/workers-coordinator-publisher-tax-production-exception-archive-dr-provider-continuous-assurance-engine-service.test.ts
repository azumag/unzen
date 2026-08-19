import { describe, expect, it, vi } from 'vitest';
import {
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
} from '../src/evidence.js';
import {
  createContinuousAssuranceEvidenceValidationOptions,
  createContinuousAssuranceServiceBindingExecutor,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService,
  validateContinuousAssuranceEngineBootstrapSnapshot,
  type ContinuousAssuranceAutomationResult,
  type ContinuousAssuranceEngineClaim,
  type ContinuousAssuranceEngineRuntimeRequest,
  type ContinuousAssuranceEngineSnapshot,
  type ContinuousAssuranceEngineStateRepository,
  type ContinuousAssuranceServiceBinding,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.js';
import type {
  ContinuousAssuranceActionContext,
  ContinuousAssuranceExecutor,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-automation.js';
import type { ProviderSteadyStateOperationsPayload } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.js';

const SCHEDULED_AT = Date.parse('2026-08-20T00:30:00.000Z');
const DELIVERY_AT = SCHEDULED_AT + 1_000;
const SCOPE = 'publisher-tax-exception-archive-dr';
const CRON = '*/5 * * * *';

function runtimeRequest(overrides: Partial<ContinuousAssuranceEngineRuntimeRequest> = {}): ContinuousAssuranceEngineRuntimeRequest {
  const base = {
    scope: SCOPE,
    cron: CRON,
    scheduledTimeMs: SCHEDULED_AT,
    deliveryAtMs: DELIVERY_AT,
    replayCount: 0,
  };
  return {
    ...base,
    triggerKey: `${base.scope}:${base.cron}:${base.scheduledTimeMs}`,
    ...overrides,
  };
}

function evidence(runId: string): EvidenceEnvelope<ProviderSteadyStateOperationsPayload> {
  return { runId } as unknown as EvidenceEnvelope<ProviderSteadyStateOperationsPayload>;
}

function snapshot(runId = 'aggregate-1'): ContinuousAssuranceEngineSnapshot {
  const inputEvidence = evidence(runId);
  return {
    steadyStateOperationsEvidence: inputEvidence,
    steadyStateOperationsReport: {
      status: 'pass',
      steadyStateInputEvidence: inputEvidence,
      steadyStateEvidenceSummary: { runId },
      cycleInputEvidence: [],
    } as unknown as ContinuousAssuranceEngineSnapshot['steadyStateOperationsReport'],
    updatedAtMs: DELIVERY_AT - 10_000,
  };
}

function automationResult(
  status: 'pass' | 'idle' | 'hold',
  nextRunId = 'aggregate-2',
): ContinuousAssuranceAutomationResult {
  const nextEvidence = evidence(nextRunId);
  const nextReport = {
    status: 'pass',
    steadyStateInputEvidence: nextEvidence,
    steadyStateEvidenceSummary: { runId: nextRunId },
    cycleInputEvidence: [],
  } as unknown as ContinuousAssuranceEngineSnapshot['steadyStateOperationsReport'];
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-automation',
    status,
    cycleId: 'cycle-4',
    attempts: [],
    paging: { attempted: false, succeeded: true, dedupeKey: null },
    finalSteadyStateReport: status === 'pass' ? nextReport : null,
    newCycleEvidence: null,
    newAggregateEvidence: status === 'pass' ? nextEvidence : null,
    bottlenecksToIssue: [],
    ...(status === 'hold' ? { failureReason: 'held-for-test' } : {}),
  } as unknown as ContinuousAssuranceAutomationResult;
}

class MemoryRepository implements ContinuousAssuranceEngineStateRepository {
  current: ContinuousAssuranceEngineSnapshot | null = snapshot();
  completed = new Map<string, ContinuousAssuranceAutomationResult>();
  activeTriggerKey: string | null = null;
  replayCount = new Map<string, number>();
  firstFailure = new Map<string, string>();
  completePassCalls = 0;
  completeCalls = 0;
  forceCasConflict = false;

  async loadSnapshot() {
    return this.current;
  }

  async claimExecution({ request, baseAggregateRunId }: {
    readonly request: ContinuousAssuranceEngineRuntimeRequest;
    readonly baseAggregateRunId: string;
  }): Promise<ContinuousAssuranceEngineClaim> {
    const completed = this.completed.get(request.triggerKey);
    if (completed) return { kind: 'completed', result: completed };
    if (this.activeTriggerKey && this.activeTriggerKey !== request.triggerKey) {
      return { kind: 'scope-busy', activeTriggerKey: this.activeTriggerKey };
    }
    const previousReplay = this.replayCount.get(request.triggerKey);
    if (previousReplay !== undefined && request.replayCount <= previousReplay) {
      return { kind: 'in-progress', activeTriggerKey: request.triggerKey };
    }
    this.activeTriggerKey = request.triggerKey;
    this.replayCount.set(request.triggerKey, request.replayCount);
    return {
      kind: 'claimed',
      journal: {
        triggerKey: request.triggerKey,
        scope: request.scope,
        replayCount: request.replayCount,
        baseAggregateRunId,
        state: 'running',
        firstFailure: this.firstFailure.get(request.triggerKey) ?? null,
        result: null,
        committedAggregateRunId: null,
        startedAtMs: request.deliveryAtMs,
        updatedAtMs: request.deliveryAtMs,
      },
    };
  }

  async completePassExecution(input: {
    readonly triggerKey: string;
    readonly scope: string;
    readonly expectedAggregateRunId: string;
    readonly snapshot: ContinuousAssuranceEngineSnapshot;
    readonly result: ContinuousAssuranceAutomationResult;
    readonly completedAtMs: number;
  }) {
    this.completePassCalls += 1;
    if (this.forceCasConflict || this.current?.steadyStateOperationsEvidence.runId !== input.expectedAggregateRunId) return false;
    this.current = input.snapshot;
    this.completed.set(input.triggerKey, input.result);
    this.activeTriggerKey = null;
    return true;
  }

  async completeExecution(input: {
    readonly triggerKey: string;
    readonly result: ContinuousAssuranceAutomationResult;
    readonly committedAggregateRunId: string | null;
    readonly completedAtMs: number;
  }) {
    this.completeCalls += 1;
    this.completed.set(input.triggerKey, input.result);
    this.activeTriggerKey = null;
  }

  async interruptExecution(input: { readonly triggerKey: string; readonly failure: string; readonly updatedAtMs: number }) {
    if (!this.firstFailure.has(input.triggerKey)) this.firstFailure.set(input.triggerKey, input.failure);
  }
}

const unusedExecutor: ContinuousAssuranceExecutor = {
  collectProviderAudit: async () => { throw new Error('not used'); },
  retrieveArchive: async () => { throw new Error('not used'); },
  collectOperationalHealth: async () => { throw new Error('not used'); },
  rotateCredentialKeys: async () => { throw new Error('not used'); },
  runDrFailoverExercise: async () => { throw new Error('not used'); },
  archiveCycleEvidence: async () => { throw new Error('not used'); },
  captureCycleEvidence: async () => { throw new Error('not used'); },
  captureAggregateEvidence: async () => { throw new Error('not used'); },
  pageOperator: async () => { throw new Error('not used'); },
};

describe('continuous assurance engine service core', () => {
  it('rejects a runtime trigger whose deterministic identity is inconsistent', async () => {
    const repository = new MemoryRepository();
    await expect(runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService({
      request: runtimeRequest({ triggerKey: 'wrong' }),
      repository,
      executor: unusedExecutor,
      evidenceValidationOptions: {},
      automationRunner: async () => automationResult('idle'),
    })).rejects.toThrow('engine-trigger-identity-invalid');
  });

  it('returns the persisted result for a completed trigger without re-running automation', async () => {
    const repository = new MemoryRepository();
    const request = runtimeRequest();
    const persisted = automationResult('idle');
    repository.completed.set(request.triggerKey, persisted);
    const runner = vi.fn(async () => automationResult('pass'));
    const result = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService({
      request,
      repository,
      executor: unusedExecutor,
      evidenceValidationOptions: {},
      automationRunner: runner,
    });
    expect(result).toBe(persisted);
    expect(runner).not.toHaveBeenCalled();
  });

  it('atomically advances the current snapshot when automation passes', async () => {
    const repository = new MemoryRepository();
    const result = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService({
      request: runtimeRequest(),
      repository,
      executor: unusedExecutor,
      evidenceValidationOptions: {},
      automationRunner: async () => automationResult('pass', 'aggregate-2'),
    });
    expect(result.status).toBe('pass');
    expect(repository.current?.steadyStateOperationsEvidence.runId).toBe('aggregate-2');
    expect(repository.completePassCalls).toBe(1);
    expect(repository.completeCalls).toBe(0);
  });

  it('fails closed on snapshot CAS conflict and preserves the first failure', async () => {
    const repository = new MemoryRepository();
    repository.forceCasConflict = true;
    const request = runtimeRequest();
    await expect(runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService({
      request,
      repository,
      executor: unusedExecutor,
      evidenceValidationOptions: {},
      automationRunner: async () => automationResult('pass'),
    })).rejects.toThrow('engine-snapshot-cas-conflict');
    expect(repository.firstFailure.get(request.triggerKey)).toBe('engine-snapshot-cas-conflict');
    expect(repository.current?.steadyStateOperationsEvidence.runId).toBe('aggregate-1');
  });

  it('completes idle/hold results without advancing the verified snapshot', async () => {
    for (const status of ['idle', 'hold'] as const) {
      const repository = new MemoryRepository();
      const result = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService({
        request: runtimeRequest(),
        repository,
        executor: unusedExecutor,
        evidenceValidationOptions: {},
        automationRunner: async () => automationResult(status),
      });
      expect(result.status).toBe(status);
      expect(repository.current?.steadyStateOperationsEvidence.runId).toBe('aggregate-1');
      expect(repository.completePassCalls).toBe(0);
      expect(repository.completeCalls).toBe(1);
    }
  });

  it('requires a higher replay count before an interrupted trigger can run again', async () => {
    const repository = new MemoryRepository();
    const request = runtimeRequest();
    repository.activeTriggerKey = request.triggerKey;
    repository.replayCount.set(request.triggerKey, 0);
    await expect(runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService({
      request,
      repository,
      executor: unusedExecutor,
      evidenceValidationOptions: {},
      automationRunner: async () => automationResult('idle'),
    })).rejects.toThrow('engine-trigger-in-progress');

    const replay = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService({
      request: runtimeRequest({ replayCount: 1 }),
      repository,
      executor: unusedExecutor,
      evidenceValidationOptions: {},
      automationRunner: async () => automationResult('idle'),
    });
    expect(replay.status).toBe('idle');
  });
});

describe('continuous assurance engine service bindings', () => {
  it('routes provider actions with the original deterministic idempotency key', async () => {
    const observed: Array<{ path: string; key: string | null }> = [];
    const provider: ContinuousAssuranceServiceBinding = {
      fetch: async (request) => {
        observed.push({ path: new URL(request.url).pathname, key: request.headers.get('x-unzen-idempotency-key') });
        return Response.json({ auditStreamId: 'audit-1', auditCursorStart: 'a', auditCursorEnd: 'b', providerAuditRecordIds: [], observedAtMs: DELIVERY_AT });
      },
    };
    const okBinding: ContinuousAssuranceServiceBinding = { fetch: async () => Response.json({}) };
    const executor = createContinuousAssuranceServiceBindingExecutor({ provider, evidence: okBinding, pager: okBinding });
    const context: ContinuousAssuranceActionContext = {
      cycleId: 'cycle-4',
      scheduledAtMs: SCHEDULED_AT,
      nowMs: DELIVERY_AT,
      action: 'provider-audit',
      idempotencyKey: 'cycle-4:provider-audit',
      attempt: 1,
      backoffMsBeforeAttempt: 0,
    };
    await executor.collectProviderAudit(context);
    expect(observed).toEqual([{ path: '/provider/audit', key: 'cycle-4:provider-audit' }]);
  });

  it('wires artifact loading and independent verification into validateEvidenceEnvelope', async () => {
    const content = 'hello';
    const calls: string[] = [];
    const evidenceBinding: ContinuousAssuranceServiceBinding = {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (path === '/evidence/artifact/load') return Response.json({ kind: 'utf8', content });
        if (path === '/evidence/artifact/verify') {
          return Response.json({
            verifier: 'trusted-verifier',
            version: '1.0.0',
            verifiedAt: '2026-08-20T00:30:02.000Z',
            result: 'pass',
          });
        }
        return Response.json({ error: 'not-found' }, { status: 404 });
      },
    };
    const envelope = {
      schemaVersion: '1.0.0',
      evidenceKind: 'engine-test',
      evidenceLevel: 'captured-and-verified',
      readinessStatus: 'production-approved',
      producer: { name: 'test', version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
      runId: 'engine-test-1',
      capturedAt: '2026-08-20T00:30:00.000Z',
      environment: { runtime: 'node', runtimeVersion: '22', executionSurface: 'test', os: { name: 'linux', version: '24.04' } },
      scenario: { feature: 'engine', scenario: 'validation', expectedResult: 'pass' },
      artifact: { locator: 'artifact://engine-test-1', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', expiresAt: '2026-08-21T00:00:00.000Z' },
      verification: { verifier: 'trusted-verifier', version: '1.0.0', verifiedAt: '2026-08-20T00:30:02.000Z', result: 'pass' },
      redaction: { applied: true, policyVersion: 'v1' },
      payload: { ok: true },
    } as const;
    const result = await validateEvidenceEnvelope(envelope, createContinuousAssuranceEvidenceValidationOptions({
      binding: evidenceBinding,
      trustedVerifiers: [{ name: 'trusted-verifier', version: '1.0.0' }],
      now: '2026-08-20T00:31:00.000Z',
    }));
    expect(result.status).toBe('valid');
    expect(result.effectiveEvidenceLevel).toBe('captured-and-verified');
    expect(calls).toEqual(['/evidence/artifact/load', '/evidence/artifact/verify']);
  });

  it('rejects a self-reported bootstrap snapshot before it can seed engine state', async () => {
    const selfReported = {
      schemaVersion: '1.0.0', evidenceKind: 'publisher-tax-filing-production-exception-archive-dr-provider-steady-state-operations', evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed',
      producer: { name: 'test', version: '1.0.0' }, runId: 'aggregate-1', capturedAt: '2026-08-20T00:00:00.000Z',
      environment: { runtime: 'node', runtimeVersion: '22', executionSurface: 'test' }, redaction: { applied: true, policyVersion: 'v1' }, payload: { cycleRunIds: [] },
    } as unknown as EvidenceEnvelope<ProviderSteadyStateOperationsPayload>;
    const candidate = {
      steadyStateOperationsEvidence: selfReported,
      steadyStateOperationsReport: {
        status: 'pass', steadyStateEvidenceSummary: { runId: 'aggregate-1' }, steadyStateInputEvidence: selfReported, cycleInputEvidence: [],
      },
      updatedAtMs: DELIVERY_AT,
    } as unknown as ContinuousAssuranceEngineSnapshot;
    const validation = await validateContinuousAssuranceEngineBootstrapSnapshot(candidate, { now: DELIVERY_AT });
    expect(validation).toEqual({ valid: false, failureReason: 'bootstrap-evidence-not-production-approved' });
  });
});
