import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const sourceName = 'workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-automation.ts';
const docName = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-automation.md';
const command = 'npm run test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance';
const next = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-worker-runtime';

describe('publisher tax exception archive DR provider continuous assurance automation docs', () => {
  it('keeps implementation, README, PLAN, focused command and next bottleneck linked', async () => {
    const [readme, plan, docs] = await Promise.all([
      readFile(new URL('../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../PLAN.md', import.meta.url), 'utf8'),
      readFile(new URL(`../docs/${docName}`, import.meta.url), 'utf8'),
    ]);

    expect(docs).toContain(sourceName);
    expect(docs).toContain(command);
    expect(docs).toContain(next);
    expect(docs).toContain('captured-and-verified');
    expect(readme).toContain(sourceName);
    expect(readme).toContain(docName);
    expect(readme).toContain(command);
    expect(readme).toContain(next);
    expect(readme).toContain('#137');
    expect(plan).toContain(docName);
    expect(plan).toContain(next);
    expect(plan).toContain('#137');
  });
});
