import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.md';
const BOTTLENECK = 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout';

describe('production provider canary docs', () => {
  it('keeps dedicated docs and focused command aligned', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [pkg, doc] = await Promise.all([
      readFile(join(root, 'package.json'), 'utf8'),
      readFile(join(root, 'docs', DOC), 'utf8'),
    ]);
    expect(pkg).toContain('test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary');
    expect(doc).toContain('captured-and-verified');
    expect(doc).toContain('two distinct approvers');
    expect(doc).toContain('does **not** prove');
    expect(doc).toContain(BOTTLENECK);
  });
});
