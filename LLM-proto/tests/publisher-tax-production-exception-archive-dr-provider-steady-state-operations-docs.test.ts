import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../', import.meta.url);

async function read(path: string) {
  return readFile(new URL(path, ROOT), 'utf8');
}

describe('publisher tax exception archive DR provider steady-state operations docs', () => {
  it('keeps implementation, README, PLAN, focused command and next bottleneck linked', async () => {
    const [source, docs, readme, plan, pkg] = await Promise.all([
      read('src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.ts'),
      read('docs/publisher-tax-production-exception-archive-dr-provider-steady-state-operations.md'),
      read('README.md'),
      read('PLAN.md'),
      read('package.json'),
    ]);
    const sourceName = 'workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.ts';
    const docName = 'publisher-tax-production-exception-archive-dr-provider-steady-state-operations.md';
    const command = 'test:workers-publisher-tax-production-exception-archive-dr-provider-steady-state-operations';
    const next = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-automation';

    expect(source).toContain(next);
    expect(docs).toContain(next);
    expect(docs).toContain(command);
    expect(readme).toContain(sourceName);
    expect(readme).toContain(docName);
    expect(readme).toContain(command);
    expect(readme).toContain('#135');
    expect(readme).toContain(next);
    expect(plan).toContain('#135');
    expect(plan).toContain(docName);
    expect(plan).toContain(next);
    expect(pkg).toContain(command);
  });
});
