import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const nextBottleneck =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-provider-adapter-canary';

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('continuous assurance engine service documentation alignment', () => {
  it('keeps implementation, runtime config, focused command, README, PLAN, and next bottleneck aligned', async () => {
    const [source, worker, engineConfig, runtimeConfig, docs, packageJson, readme, plan] = await Promise.all([
      read('src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.ts'),
      read('worker-runtime/continuous-assurance-engine-worker.mjs'),
      read('worker-runtime/wrangler.engine.jsonc'),
      read('worker-runtime/wrangler.jsonc'),
      read('docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.md'),
      read('package.json'),
      read('README.md'),
      read('PLAN.md'),
    ]);

    expect(source).toContain('runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAutomation');
    expect(source).toContain(nextBottleneck);
    expect(source).toContain('x-unzen-idempotency-key');
    expect(source).toContain('/evidence/artifact/load');
    expect(source).toContain('/evidence/artifact/verify');
    expect(worker).toContain('ContinuousAssuranceEngineState');
    expect(worker).toContain('completePassExecution');
    expect(worker).toContain('transactionSync');
    expect(engineConfig).toContain('"name": "unzen-llm-continuous-assurance-engine"');
    expect(engineConfig).toContain('"workers_dev": false');
    expect(engineConfig).toContain('"PROVIDER_ADAPTER"');
    expect(engineConfig).toContain('"EVIDENCE_ADAPTER"');
    expect(engineConfig).toContain('"PAGER_ADAPTER"');
    expect(runtimeConfig).toContain('"service": "unzen-llm-continuous-assurance-engine"');
    expect(packageJson).toContain('test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine');
    expect(docs).toContain('#141');
    expect(docs).toContain('captured-and-verified');
    expect(docs).toContain('production-approved');
    expect(docs).toContain(nextBottleneck);
    expect(readme).toContain('#141');
    expect(readme).toContain('publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.md');
    expect(readme).toContain(nextBottleneck);
    expect(plan).toContain('v3.11');
    expect(plan).toContain('#141');
    expect(plan).toContain(nextBottleneck);
  });
});
