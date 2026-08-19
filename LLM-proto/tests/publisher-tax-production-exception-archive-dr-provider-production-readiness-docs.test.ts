import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = 'workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-readiness.ts';
const DOC = 'publisher-tax-production-exception-archive-dr-provider-production-readiness.md';
const COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-production-readiness';
const NEXT = 'publisher-tax-filing-production-exception-archive-dr-provider-production-cutover';

describe('publisher tax exception archive DR provider production readiness documentation', () => {
  it('keeps implementation, focused command, docs, plan, and next bottleneck linked', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const plan = readFileSync(new URL('../PLAN.md', import.meta.url), 'utf8');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    const doc = readFileSync(new URL(`../docs/${DOC}`, import.meta.url), 'utf8');

    expect(doc).toContain(SOURCE);
    expect(doc).toContain(COMMAND);
    expect(doc).toContain(NEXT);
    expect(readme).toContain(SOURCE);
    expect(readme).toContain(DOC);
    expect(readme).toContain(COMMAND);
    expect(readme).toContain(NEXT);
    expect(plan).toContain(DOC);
    expect(plan).toContain(NEXT);
    expect(pkg.scripts[COMMAND]).toBe('vitest run tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-readiness.test.ts');
  });
});
