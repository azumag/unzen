import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('publisher tax production exception operations documentation', () => {
  it('keeps the runbook gate linked from README, PLAN, docs, and focused command', () => {
    const spec = readProjectFile('docs/publisher-tax-production-exception-operations.md');
    const readme = readProjectFile('README.md');
    const plan = readProjectFile('PLAN.md');
    const packageJson = readProjectFile('package.json');

    expect(spec).toContain('Publisher tax production exception operations runbook');
    expect(spec).toContain('src/workers-coordinator-publisher-tax-production-exception-operations.ts');
    expect(spec).toContain('npm run test:workers-publisher-tax-production-exceptions');
    expect(spec).toContain('publisher-tax-filing-production-exception-resolution-audit');

    expect(readme).toContain('docs/publisher-tax-production-exception-operations.md');
    expect(readme).toContain('src/workers-coordinator-publisher-tax-production-exception-operations.ts');
    expect(readme).toContain('npm run test:workers-publisher-tax-production-exceptions');
    expect(readme).toContain('publisher-tax-filing-production-exception-resolution-audit');

    expect(plan).toContain('./docs/publisher-tax-production-exception-operations.md');
    expect(plan).toContain('Publisher tax filing production exception operations runbook gate (#91)');
    expect(plan).toContain('publisher-tax-filing-production-exception-resolution-audit');

    expect(packageJson).toContain('test:workers-publisher-tax-production-exceptions');
    expect(packageJson).toContain(
      'tests/workers-coordinator-publisher-tax-production-exception-operations.test.ts',
    );
  });
});
