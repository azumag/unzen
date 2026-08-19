import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const SOURCE = 'workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-cutover.ts';
const DOC = 'publisher-tax-production-exception-archive-dr-provider-production-cutover.md';
const COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-production-cutover';
const NEXT = 'publisher-tax-filing-production-exception-archive-dr-provider-post-cutover-reconciliation';

describe('publisher tax exception archive DR provider production cutover documentation', () => {
  it('keeps implementation, focused command, docs, plan, and next bottleneck linked', async () => {
    const [readme, plan, doc, pkg] = await Promise.all([
      readFile(new URL('../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../PLAN.md', import.meta.url), 'utf8'),
      readFile(new URL(`../docs/${DOC}`, import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ]);
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
