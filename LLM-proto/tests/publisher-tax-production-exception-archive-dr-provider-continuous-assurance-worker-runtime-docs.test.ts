import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const SOURCE = 'src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-worker-runtime-smoke.ts';
const WORKER = 'worker-runtime/continuous-assurance-worker.mjs';
const CONFIG = 'worker-runtime/wrangler.jsonc';
const DOC = 'docs/publisher-tax-production-exception-archive-dr-provider-continuous-assurance-worker-runtime.md';
const COMMAND = 'npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-runtime';
const NEXT = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-engine-service-deployment';

async function text(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('continuous assurance Worker runtime documentation links', () => {
  it('keeps README, PLAN and dedicated docs aligned with #139', async () => {
    const [readme, plan, doc] = await Promise.all([
      text('README.md'),
      text('PLAN.md'),
      text(DOC),
    ]);

    for (const body of [readme, plan, doc]) {
      expect(body).toContain('#139');
      expect(body).toContain(NEXT);
    }
    expect(readme).toContain(SOURCE);
    expect(readme).toContain(WORKER);
    expect(readme).toContain(CONFIG);
    expect(readme).toContain(DOC);
    expect(readme).toContain(COMMAND);
    expect(plan).toContain(DOC);
    expect(plan).toContain(WORKER);
    expect(plan).toContain(CONFIG);
    expect(doc).toContain(COMMAND);
    expect(doc).toContain('2026-08-20');
    expect(doc).toContain('2025-01-01');
    expect(doc).toContain('ASSURANCE_ENGINE');
  });
});
