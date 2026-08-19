import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = 'workers-coordinator-publisher-tax-production-exception-archive-dr-provider-pilot.ts';
const DOC = 'docs/publisher-tax-production-exception-archive-dr-provider-pilot.md';
const COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-pilot';
const NEXT = 'publisher-tax-filing-production-exception-archive-dr-provider-production-readiness';

describe('publisher tax exception archive DR provider pilot documentation', () => {
  it('keeps implementation, focused command, docs, plan, and next bottleneck linked', () => {
    const readme = readFileSync('README.md', 'utf8');
    const plan = readFileSync('PLAN.md', 'utf8');
    const doc = readFileSync(DOC, 'utf8');
    const pkg = readFileSync('package.json', 'utf8');

    expect(doc).toContain(SOURCE);
    expect(doc).toContain(COMMAND);
    expect(doc).toContain(NEXT);
    expect(readme).toContain(SOURCE);
    expect(readme).toContain(DOC);
    expect(readme).toContain(COMMAND);
    expect(readme).toContain(NEXT);
    expect(plan).toContain(DOC);
    expect(plan).toContain(NEXT);
    expect(pkg).toContain(COMMAND);
  });
});
