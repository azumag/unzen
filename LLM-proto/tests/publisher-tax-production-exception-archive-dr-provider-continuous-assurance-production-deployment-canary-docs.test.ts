import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.md';
const BOTTLENECK = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary';

describe('continuous assurance production deployment canary docs', () => {
  it('keeps README, PLAN and dedicated docs linked and evidence-scoped', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [readme, plan, doc] = await Promise.all([
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'PLAN.md'), 'utf8'),
      readFile(join(root, 'docs', DOC), 'utf8'),
    ]);
    expect(readme).toContain(`docs/${DOC}`);
    expect(readme).toContain('test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary');
    expect(readme).toContain('#145');
    expect(plan).toContain(`docs/${DOC}`);
    expect(plan).toContain('#145');
    expect(plan).toContain('v3.13');
    expect(plan).toContain(BOTTLENECK);
    expect(doc).toContain('captured-and-verified');
    expect(doc).toContain('read-only');
    expect(doc).toContain('not** evidence');
    expect(doc).toContain(BOTTLENECK);
  });
});
