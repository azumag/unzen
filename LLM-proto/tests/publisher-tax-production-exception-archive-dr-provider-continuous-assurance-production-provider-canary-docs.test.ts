import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md';
const BOTTLENECK = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout';

describe('production provider canary docs', () => {
  it('keeps README, PLAN and dedicated docs aligned', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [readme, plan, doc] = await Promise.all([
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'PLAN.md'), 'utf8'),
      readFile(join(root, 'docs', DOC), 'utf8'),
    ]);
    expect(readme).toContain(`docs/${DOC}`);
    expect(readme).toContain('test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary');
    expect(readme).toContain('#149');
    expect(plan).toContain(`docs/${DOC}`);
    expect(plan).toContain('#149');
    expect(plan).toContain(BOTTLENECK);
    expect(doc).toContain('does **not** prove');
    expect(doc).toContain('two distinct approvers');
    expect(doc).toContain(BOTTLENECK);
  });
});
