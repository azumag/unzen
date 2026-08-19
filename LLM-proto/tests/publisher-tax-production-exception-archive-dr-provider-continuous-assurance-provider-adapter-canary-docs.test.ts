import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-provider-adapter-canary.md';
const BOTTLENECK = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary';

describe('continuous assurance provider adapter canary docs', () => {
  it('keeps README, PLAN and dedicated docs linked and evidence-scoped', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [readme, plan, doc] = await Promise.all([
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'PLAN.md'), 'utf8'),
      readFile(join(root, 'docs', DOC), 'utf8'),
    ]);
    expect(readme).toContain(`docs/${DOC}`);
    expect(readme).toContain('test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters');
    expect(readme).toContain('#143');
    expect(plan).toContain(`docs/${DOC}`);
    expect(plan).toContain('#143');
    expect(plan).toContain(BOTTLENECK);
    expect(doc).toContain('captured-and-verified');
    expect(doc).toContain('Miniflare');
    expect(doc).toContain('does **not** prove');
    expect(doc).toContain(BOTTLENECK);
  });
});
