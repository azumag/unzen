import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const SOURCE = 'workers-coordinator-publisher-tax-production-exception-archive-disaster-recovery-operations.ts';
const DOC = 'docs/publisher-tax-production-exception-archive-disaster-recovery-operations.md';
const COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr';
const NEXT = 'publisher-tax-filing-production-exception-archive-dr-provider-pilot';

describe('publisher tax exception archive DR operations documentation', () => {
  it('keeps implementation, focused command, docs, plan, and next bottleneck linked', async () => {
    const [doc, readme, plan, packageJson] = await Promise.all([
      readFile(new URL(`../${DOC}`, import.meta.url), 'utf8'),
      readFile(new URL('../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../PLAN.md', import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ]);

    expect(doc).toContain(SOURCE);
    expect(doc).toContain(COMMAND);
    expect(doc).toContain(NEXT);
    expect(readme).toContain(SOURCE);
    expect(readme).toContain(DOC);
    expect(readme).toContain(COMMAND);
    expect(plan).toContain(DOC);
    expect(plan).toContain(NEXT);
    expect(packageJson).toContain(COMMAND);
  });
});
