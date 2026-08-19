import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('publisher tax production exception resolution audit documentation', () => {
  it('keeps implementation, focused command, README, PLAN, and next bottleneck linked', () => {
    const spec = read('docs/publisher-tax-production-exception-resolution-audit.md');
    const readme = read('README.md');
    const plan = read('PLAN.md');
    const packageJson = read('package.json');

    expect(spec).toContain('Publisher tax production exception resolution audit');
    expect(spec).toContain('src/workers-coordinator-publisher-tax-production-exception-resolution-audit.ts');
    expect(spec).toContain('npm run test:workers-publisher-tax-production-exception-resolution');
    expect(spec).toContain('publisher-tax-filing-production-exception-audit-archive-retention');
    expect(packageJson).toContain('test:workers-publisher-tax-production-exception-resolution');
    expect(readme).toContain('workers-coordinator-publisher-tax-production-exception-resolution-audit.ts');
    expect(readme).toContain('docs/publisher-tax-production-exception-resolution-audit.md');
    expect(readme).toContain('test:workers-publisher-tax-production-exception-resolution');
    expect(plan).toContain('publisher-tax-production-exception-resolution-audit.md');
    expect(plan).toContain('publisher-tax-filing-production-exception-audit-archive-retention');
  });
});
