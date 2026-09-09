import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

interface LifecycleResponse {
  readonly scope: 'module' | 'request';
  readonly result: number;
  readonly requestCount: number;
  readonly instantiationCount: number;
  readonly moduleType: string;
}

interface TimingEvidence {
  readonly scope: 'module' | 'request';
  readonly startupMs: number;
  readonly firstRequestMs: number;
  readonly warmRequestMs: readonly number[];
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const moduleScriptPath = join(projectRoot, 'worker-runtime', 'wasm-lifecycle-module-worker.mjs');
const requestScriptPath = join(projectRoot, 'worker-runtime', 'wasm-lifecycle-request-worker.mjs');
const COMPATIBILITY_DATE = '2026-08-06';

function createRuntime(scriptPath: string): Miniflare {
  return new Miniflare({
    modules: true,
    modulesRoot: projectRoot,
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
    scriptPath,
    compatibilityDate: COMPATIBILITY_DATE,
  });
}

async function timedRequest(mf: Miniflare): Promise<{
  readonly elapsedMs: number;
  readonly body: LifecycleResponse;
}> {
  const startedAt = performance.now();
  const response = await mf.dispatchFetch('https://wasm-lifecycle.internal/');
  const elapsedMs = performance.now() - startedAt;
  expect(response.status).toBe(200);
  return {
    elapsedMs,
    body: (await response.json()) as LifecycleResponse,
  };
}

async function measure(
  scope: 'module' | 'request',
  scriptPath: string,
): Promise<{
  readonly responses: readonly LifecycleResponse[];
  readonly evidence: TimingEvidence;
}> {
  const startupStartedAt = performance.now();
  const mf = createRuntime(scriptPath);
  try {
    await mf.ready;
    const startupMs = performance.now() - startupStartedAt;
    const first = await timedRequest(mf);
    const warm = [await timedRequest(mf), await timedRequest(mf), await timedRequest(mf)];
    const evidence: TimingEvidence = {
      scope,
      startupMs,
      firstRequestMs: first.elapsedMs,
      warmRequestMs: warm.map((sample) => sample.elapsedMs),
    };
    console.log(JSON.stringify({ event: 'unzen_wasm_lifecycle_timing', ...evidence }));
    return {
      responses: [first.body, ...warm.map((sample) => sample.body)],
      evidence,
    };
  } finally {
    await mf.dispose();
  }
}

function expectTimingEvidence(evidence: TimingEvidence): void {
  for (const value of [
    evidence.startupMs,
    evidence.firstRequestMs,
    ...evidence.warmRequestMs,
  ]) {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
}

describe('Cloudflare Wasm instantiate lifecycle measurement', () => {
  it('keeps module-scope instantiation at one while request-scope instantiates per request', async () => {
    const moduleRun = await measure('module', moduleScriptPath);
    const requestRun = await measure('request', requestScriptPath);

    expectTimingEvidence(moduleRun.evidence);
    expectTimingEvidence(requestRun.evidence);

    for (const [index, response] of moduleRun.responses.entries()) {
      expect(response).toEqual({
        scope: 'module',
        result: 0,
        requestCount: index + 1,
        instantiationCount: 1,
        moduleType: 'WebAssembly.Module',
      });
    }

    for (const [index, response] of requestRun.responses.entries()) {
      expect(response).toEqual({
        scope: 'request',
        result: 0,
        requestCount: index + 1,
        instantiationCount: index + 1,
        moduleType: 'WebAssembly.Module',
      });
    }

    expect(moduleRun.responses.map((response) => response.result)).toEqual(
      requestRun.responses.map((response) => response.result),
    );
  });

  it('re-instantiates module scope after Miniflare restart without changing correctness', async () => {
    const firstRuntime = createRuntime(moduleScriptPath);
    let first: LifecycleResponse;
    try {
      await firstRuntime.ready;
      first = (await timedRequest(firstRuntime)).body;
      expect((await timedRequest(firstRuntime)).body.requestCount).toBe(2);
    } finally {
      await firstRuntime.dispose();
    }

    const restartedRuntime = createRuntime(moduleScriptPath);
    try {
      await restartedRuntime.ready;
      const restarted = (await timedRequest(restartedRuntime)).body;
      expect(first).toMatchObject({
        scope: 'module',
        result: 0,
        requestCount: 1,
        instantiationCount: 1,
      });
      expect(restarted).toMatchObject({
        scope: 'module',
        result: 0,
        requestCount: 1,
        instantiationCount: 1,
      });
    } finally {
      await restartedRuntime.dispose();
    }
  });
});
