import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOC = 'publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.md';
const COMMAND = 'test:workers-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout';

describe('production operations rollout docs', () => {
  it('documents the terminal rollout contract and focused command', async () => {
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const [doc, pkg] = await Promise.all([
      readFile(join(root, 'docs', DOC), 'utf8'),
      readFile(join(root, 'package.json'), 'utf8'),
    ]);
    expect(doc).toContain('does **not** prove');
    expect(doc).toContain('two distinct approvers');
    expect(doc).toContain('steady-state-enabled');
    expect(doc).toContain('bottlenecksToIssue: []');
    expect(doc).toContain('ends the validator chain');
    expect(pkg).toContain(COMMAND);
  });
});
