import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const sourceFile = 'src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-post-cutover-reconciliation.ts';
const docsFile = 'docs/publisher-tax-production-exception-archive-dr-provider-post-cutover-reconciliation.md';
const focusedCommand = 'test:workers-publisher-tax-production-exception-archive-dr-provider-post-cutover-reconciliation';
const nextBottleneck = 'publisher-tax-filing-production-exception-archive-dr-provider-steady-state-operations';

describe('publisher tax exception archive DR provider post-cutover reconciliation docs', () => {
  it('keeps implementation, command, README, PLAN, docs and next bottleneck linked', async () => {
    const [source, docs, readme, plan, pkg] = await Promise.all([
      readFile(sourceFile, 'utf8'), readFile(docsFile, 'utf8'), readFile('README.md', 'utf8'),
      readFile('PLAN.md', 'utf8'), readFile('package.json', 'utf8'),
    ]);
    expect(source).toContain(nextBottleneck);
    expect(docs).toContain(sourceFile);
    expect(docs).toContain(focusedCommand);
    expect(docs).toContain(nextBottleneck);
    expect(readme).toContain(sourceFile);
    expect(readme).toContain(docsFile);
    expect(readme).toContain(focusedCommand);
    expect(readme).toContain('#133');
    expect(readme).toContain(nextBottleneck);
    expect(plan).toContain('#133');
    expect(plan).toContain(docsFile);
    expect(plan).toContain(nextBottleneck);
    expect(pkg).toContain(focusedCommand);
  });
});
