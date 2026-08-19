import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

async function read(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

describe('publisher tax exception archive restore documentation', () => {
  it('keeps restore drill implementation, command, docs, plan, and next bottleneck linked', async () => {
    const [readme, plan, spec, packageJson] = await Promise.all([
      read('README.md'),
      read('PLAN.md'),
      read('docs/publisher-tax-production-exception-archive-restore-drill.md'),
      read('package.json'),
    ]);

    expect(readme).toContain('workers-coordinator-publisher-tax-production-exception-archive-restore-drill.ts');
    expect(readme).toContain('docs/publisher-tax-production-exception-archive-restore-drill.md');
    expect(readme).toContain('test:workers-publisher-tax-production-exception-archive-restore');
    expect(readme).toContain('publisher-tax-filing-production-exception-archive-disaster-recovery-operations');
    expect(plan).toContain('publisher-tax-production-exception-archive-restore-drill.md');
    expect(plan).toContain('publisher-tax-filing-production-exception-archive-disaster-recovery-operations');
    expect(spec).toContain('src/workers-coordinator-publisher-tax-production-exception-archive-restore-drill.ts');
    expect(spec).toContain('npm run test:workers-publisher-tax-production-exception-archive-restore');
    expect(spec).toContain('publisher-tax-filing-production-exception-archive-disaster-recovery-operations');
    expect(packageJson).toContain('test:workers-publisher-tax-production-exception-archive-restore');
  });
});
