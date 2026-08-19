import { Miniflare } from 'miniflare';

export const CONTINUOUS_ASSURANCE_RUNTIME_CRON = '*/5 * * * *';
export const CONTINUOUS_ASSURANCE_RUNTIME_SCOPE = 'publisher-tax-exception-archive-dr';

export interface ContinuousAssuranceRuntimeEngineRequest {
  readonly scope: string;
  readonly triggerKey: string;
  readonly cron: string;
  readonly scheduledTimeMs: number;
  readonly deliveryAtMs: number;
  readonly replayCount: number;
}

export interface ContinuousAssuranceRuntimeLedger {
  readonly triggerKey: string;
  readonly scope: string;
  readonly cron: string;
  readonly scheduledAtMs: number;
  readonly state: 'running' | 'completed';
  readonly replayCount: number;
  readonly attemptCount: number;
  readonly leaseUntilMs: number;
  readonly cycleId: string | null;
  readonly actionKeys: readonly string[];
  readonly firstFailure: string | null;
  readonly paging: unknown;
  readonly latestCycleRunId: string | null;
  readonly latestAggregateRunId: string | null;
  readonly result: unknown;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly updatedAtMs: number;
}

export interface ContinuousAssuranceRuntimeMiniflareOptions {
  readonly durableObjectsPersistRoot: string;
  readonly engine: (request: ContinuousAssuranceRuntimeEngineRequest) => Promise<unknown>;
  readonly scope?: string;
  readonly leaseMs?: number;
}

interface RuntimeStateStub {
  readLedger(triggerKey: string): Promise<ContinuousAssuranceRuntimeLedger | null>;
}

export function continuousAssuranceTriggerKey(
  scope: string,
  cron: string,
  scheduledTimeMs: number,
): string {
  return `${scope}:${cron}:${scheduledTimeMs}`;
}

export function createContinuousAssuranceWorkerRuntimeMiniflare(
  options: ContinuousAssuranceRuntimeMiniflareOptions,
): Miniflare {
  const scriptPath = decodeURIComponent(
    new URL(
      '../worker-runtime/continuous-assurance-worker.mjs',
      import.meta.url,
    ).pathname,
  );

  return new Miniflare({
    modules: true,
    scriptPath,
    compatibilityDate: '2026-08-20',
    compatibilityFlags: ['nodejs_compat'],
    crons: [CONTINUOUS_ASSURANCE_RUNTIME_CRON],
    bindings: {
      CONTINUOUS_ASSURANCE_SCOPE: options.scope ?? CONTINUOUS_ASSURANCE_RUNTIME_SCOPE,
      RUN_LEASE_MS: String(options.leaseMs ?? 60_000),
    },
    durableObjects: {
      CONTINUOUS_ASSURANCE_STATE: {
        className: 'ContinuousAssuranceRuntimeState',
        useSQLite: true,
      },
    },
    durableObjectsPersist: options.durableObjectsPersistRoot,
    serviceBindings: {
      ASSURANCE_ENGINE: async (request) => {
        const payload = await request.json() as ContinuousAssuranceRuntimeEngineRequest;
        try {
          return Response.json(await options.engine(payload));
        } catch (error) {
          return Response.json({
            error: error instanceof Error ? error.message : String(error),
          }, { status: 503 });
        }
      },
    },
  });
}

export async function dispatchContinuousAssuranceScheduled(
  mf: Miniflare,
  scheduledTimeMs: number,
  cron = CONTINUOUS_ASSURANCE_RUNTIME_CRON,
): Promise<void> {
  const worker = await mf.getWorker();
  await worker.scheduled({
    scheduledTime: new Date(scheduledTimeMs),
    cron,
  });
}

export async function readContinuousAssuranceRuntimeLedger(
  mf: Miniflare,
  scheduledTimeMs: number,
  scope = CONTINUOUS_ASSURANCE_RUNTIME_SCOPE,
  cron = CONTINUOUS_ASSURANCE_RUNTIME_CRON,
): Promise<ContinuousAssuranceRuntimeLedger | null> {
  const namespace = await mf.getDurableObjectNamespace('CONTINUOUS_ASSURANCE_STATE');
  const stub = namespace.getByName(scope) as unknown as RuntimeStateStub;
  return stub.readLedger(continuousAssuranceTriggerKey(scope, cron, scheduledTimeMs));
}
