import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('publisher tax production exception archive / retention documentation', () => {
  it('keeps implementation, focused command, README, PLAN, and next bottleneck linked', () => {
    const spec = readProjectFile('docs/publisher-tax-production-exception-audit-archive-retention.md');
    const readme = readProjectFile('README.md');
    const plan = readProjectFile('PLAN.md');
    const pkg = readProjectFile('package.json');

    expect(spec).toContain('Publisher tax production exception audit archive / retention');
    expect(spec).toContain('src/workers-coordinator-publisher-tax-production-exception-audit-archive-retention.ts');
    expect(spec).toContain('npm run test:workers-publisher-tax-production-exception-archive');
    expect(spec).toContain('publisher-tax-filing-production-exception-archive-restore-drill');
    expect(readme).toContain('src/workers-coordinator-publisher-tax-production-exception-audit-archive-retention.ts');
    expect(readme).toContain('docs/publisher-tax-production-exception-audit-archive-retention.md');
    expect(readme).toContain('npm run test:workers-publisher-tax-production-exception-archive');
    expect(readme).toContain('publisher-tax-filing-production-exception-archive-restore-drill');
    expect(plan).toContain('./docs/publisher-tax-production-exception-audit-archive-retention.md');
    expect(plan).toContain('publisher-tax-filing-production-exception-archive-restore-drill');
    expect(pkg).toContain('test:workers-publisher-tax-production-exception-archive');
  });
});
